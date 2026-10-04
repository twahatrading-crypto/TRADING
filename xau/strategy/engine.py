"""Setup state machine:  Liquidity -> Sweep -> MSS -> Displacement -> FVG ->
Retracement -> Entry -> Target.

``StrategyEngine.on_bar(snapshot)`` is called once per *closed* M5 candle, in
order, by BOTH the live server and the backtester.  The snapshot contains only
candles closed at ``snapshot.now``; the engine keeps no other market data, so
it cannot see the future.  All decisions are made on candle closes; tick-level
"price is in the zone" information is display-only and never creates a signal.

Price model for fills/exits (MT5 chart candles are BID prices):
  SELL: entry fills when bid high >= entry; SL when bid high + spread >= SL;
        TP when bid low + spread <= TP.
  BUY : entry fills when bid low + spread <= entry; SL when bid low <= SL;
        TP when bid high >= TP.
  If SL and a target are both inside one candle, the SL is assumed first.
"""
from __future__ import annotations

import copy
from bisect import bisect_left
from dataclasses import asdict, dataclass, field
from typing import Optional

from ..config import StrategyConfig
from ..models import Candle
from ..sessions import SessionEngine
from ..timeutil import parse_iso_utc
from . import scoring
from .displacement import find_displacement
from .fvg import FVG, find_fvgs, select_fvg, touched_since
from .indicators import atr
from .liquidity import Level, compute_levels
from .market import Snapshot
from .plan import build_plan, compute_sl
from .structure import check_mss, protected_swing
from .sweep import detect_sweeps, pick_sweep
from .swings import Swing, structure_bias

# setup stages
SWEPT, MSS_DONE, DISPLACED, RETRACE, TRADE, ENDED = "SWEPT", "MSS", "DISPLACED", "RETRACE", "TRADE", "ENDED"

# terminal statuses
NO_TRADE, INVALIDATED, EXPIRED, CLOSED = "NO_TRADE", "INVALIDATED", "EXPIRED", "CLOSED"

R_EXITS = (2.0, 3.0, 4.0)


@dataclass
class Setup:
    id: str
    symbol: str
    direction: str
    created_time: int                 # open time of the bar that confirmed the sweep
    stage: str = SWEPT
    status: str = "FORMING"           # FORMING | WAITING_RETRACEMENT | SIGNAL | NO_TRADE | INVALIDATED | EXPIRED | CLOSED
    sweep: dict = field(default_factory=dict)
    protected: Optional[dict] = None
    mss: Optional[dict] = None
    displacement: Optional[dict] = None
    fvg: Optional[dict] = None
    fvg_selected_time: Optional[int] = None
    plan: Optional[dict] = None
    entry_time: Optional[int] = None
    entry_price: Optional[float] = None
    session: str = ""
    bias: dict = field(default_factory=dict)
    filters: dict = field(default_factory=dict)
    score: dict = field(default_factory=dict)
    score_total: int = 0
    score_provisional: bool = False
    grade: str = ""                   # "A+" | "BELOW_THRESHOLD" | "FILTERED" | ""
    taken: bool = False               # True = would be an actual A+ signal
    reasons: list = field(default_factory=list)
    failed_stage: str = ""
    ended_time: Optional[int] = None
    trade: dict = field(default_factory=dict)
    zone_touched: bool = False
    updated_time: int = 0

    def to_dict(self) -> dict:
        return asdict(self)

    @property
    def active(self) -> bool:
        return self.stage not in (ENDED,)


def _idx(times: list[int], t: int) -> Optional[int]:
    i = bisect_left(times, t)
    return i if i < len(times) and times[i] == t else None


class StrategyEngine:
    def __init__(self, cfg: StrategyConfig, sessions: SessionEngine, symbol: str = "XAUUSD",
                 one_trade_at_a_time: bool = True):
        self.cfg = cfg
        self.sessions = sessions
        self.symbol = symbol
        self.one_trade_at_a_time = one_trade_at_a_time
        self.setup: Optional[Setup] = None          # setup in progress (pre-entry)
        self.trades: list[Setup] = []               # entered setups being tracked
        self.history: list[Setup] = []              # finished setups (most recent last)
        self.levels: list[Level] = []
        self.ctx: dict = {}
        self.last_bar_time: Optional[int] = None
        self._news = self._parse_news()
        self._cache: dict = {}        # results keyed by identical closed-candle inputs only

    def _parse_news(self) -> list[tuple[int, str]]:
        out = []
        for ev in self.cfg.filters.news_events or []:
            try:
                out.append((parse_iso_utc(ev["time"]), ev.get("title", "news")))
            except Exception:
                continue
        return out

    # ------------------------------------------------------------------ main
    def on_bar(self, snap: Snapshot, feed_live: bool = True) -> list[dict]:
        """Process the newest closed M5 candle in ``snap``. Returns changed setups."""
        m5 = snap.m5()
        if len(m5) < 50:
            return []
        cur = m5[-1]
        if self.last_bar_time is not None and cur.time <= self.last_bar_time:
            return []      # already processed (idempotent)
        self.last_bar_time = cur.time
        if snap.spec is not None:
            self.symbol = snap.spec.name
        changed: dict[str, Setup] = {}

        point = snap.spec.point if snap.spec else 0.01
        dcfg = self.cfg.displacement
        a5 = atr(m5, dcfg.atr_period)
        a1 = atr(snap.bars.get("H1", []), 14)
        k = self.cfg.filters.htf_swing_strength
        bias = {"H1": self._bias(snap, "H1", 120, k), "M15": self._bias(snap, "M15", 160, k)}
        levels = compute_levels(snap, self.cfg.liquidity, self.sessions, a5,
                                keep_taken_within_bars=self.cfg.sweep.reclaim_max_bars, cache=self._cache)
        self.levels = levels
        spread_pts = cur.spread or (snap.spec.spread_points if snap.spec else 0)
        spread = spread_pts * point
        times = [c.time for c in m5]
        self.ctx = {"time": cur.time, "now": snap.now, "atr_m5": a5, "atr_h1": a1, "bias": bias,
                    "point": point, "spread": spread, "sessions": self.sessions.active(cur.time),
                    "close": cur.close}

        # 1) open trades
        for t in list(self.trades):
            if self._update_trade(t, cur, spread):
                changed[t.id] = t
            if t.stage == ENDED:
                self.trades.remove(t)
                self._archive(t)

        # 2) setup in progress
        if self.setup is not None:
            before = (self.setup.stage, self.setup.status)
            self._advance(self.setup, m5, times, levels, feed_live)
            if (self.setup.stage, self.setup.status) != before:
                changed[self.setup.id] = self.setup
            if self.setup.stage in (TRADE, ENDED):
                if self.setup.stage == TRADE:
                    self.trades.append(self.setup)
                else:
                    self._archive(self.setup)
                self.setup = None

        # 3) look for a new sweep
        if self.setup is None:
            sw = pick_sweep(detect_sweeps(m5, levels, a5, self.cfg.sweep, point))
            if sw is not None:
                s = Setup(id=f"{self.symbol}-{sw.direction}-{sw.sweep_time}", symbol=self.symbol,
                          direction=sw.direction, created_time=cur.time, sweep=sw.to_dict())
                if not any(h.id == s.id for h in self.history[-5:]):
                    self.setup = s
                    self._advance(s, m5, times, levels, feed_live)
                    changed[s.id] = s
                    if s.stage == TRADE:
                        self.trades.append(s); self.setup = None
                    elif s.stage == ENDED:
                        self._archive(s); self.setup = None

        for s in changed.values():
            s.updated_time = cur.time
        return [s.to_dict() for s in changed.values()]

    def _bias(self, snap: Snapshot, tf: str, n: int, k: int) -> str:
        bars = snap.bars.get(tf, [])[-n:]
        key = ("bias", tf, k, len(bars), bars[-1].time if bars else 0, bars[0].time if bars else 0)
        if key not in self._cache:
            if len(self._cache) > 64:
                self._cache.clear()
            self._cache[key] = structure_bias(bars, k, tf)
        return self._cache[key]

    def _archive(self, s: Setup) -> None:
        self.history.append(s)
        if len(self.history) > 200:
            self.history = self.history[-200:]

    def _end(self, s: Setup, status: str, reason: str, t: int) -> None:
        s.failed_stage = s.failed_stage or s.stage
        s.stage, s.status, s.ended_time = ENDED, status, t
        s.reasons.append(reason)

    # --------------------------------------------------------------- advance
    def _advance(self, s: Setup, m5: list[Candle], times: list[int], levels: list[Level],
                 feed_live: bool) -> None:
        cur = m5[-1]
        i = len(m5) - 1
        sell = s.direction == "SELL"
        sw = s.sweep
        ext = sw["extreme_price"]
        ext_i = _idx(times, sw["extreme_time"])
        rec_i = _idx(times, sw["reclaim_time"])
        a5 = self.ctx["atr_m5"]
        if ext_i is None or rec_i is None:
            self._end(s, EXPIRED, "sweep left the data window", cur.time)
            return

        # invalidation common to all pre-entry stages
        if s.stage in (SWEPT, MSS_DONE, DISPLACED, RETRACE):
            if i > rec_i and ((sell and cur.high > ext) or (not sell and cur.low < ext)):
                if s.stage != RETRACE:   # in RETRACE the SL check below handles it
                    self._end(s, INVALIDATED, "price traded beyond the sweep extreme before entry", cur.time)
                    return
            if s.stage == SWEPT and i > rec_i and (
                    (sell and cur.close > sw["level_price"]) or (not sell and cur.close < sw["level_price"])):
                self._end(s, INVALIDATED, "price closed back beyond the swept level (failed sweep)", cur.time)
                return

        for _ in range(4):   # allow several stages to complete on the same candle
            prev = s.stage
            if s.stage == SWEPT:
                self._stage_mss(s, m5, i, ext_i, rec_i)
            elif s.stage == MSS_DONE:
                self._stage_displacement(s, m5, times, i, ext_i)
            elif s.stage == DISPLACED:
                self._stage_fvg(s, m5, times, i, ext_i, levels)
            elif s.stage == RETRACE:
                if s.fvg_selected_time is not None and cur.time > s.fvg_selected_time:
                    self._stage_retrace(s, m5, times, i, levels, feed_live)
                    if s.stage == RETRACE:
                        self._provisional_score(s, cur)
                break
            if s.stage == prev or s.stage == ENDED:
                break

    def _stage_mss(self, s: Setup, m5, i, ext_i, rec_i) -> None:
        cfg = self.cfg.mss
        cur = m5[i]
        if i - rec_i > cfg.max_bars_after_sweep:
            self._end(s, EXPIRED, f"no M5 structure shift within {cfg.max_bars_after_sweep} bars of the sweep", cur.time)
            return
        if s.protected is None:
            sw = protected_swing(m5, ext_i, s.direction, cfg)
            if sw is None:
                if i - ext_i > cfg.swing_strength:
                    self._end(s, NO_TRADE, "no confirmed protected swing before the sweep", cur.time)
                return
            s.protected = asdict(sw)
        swing = Swing(**s.protected)
        m = check_mss(cur, swing, s.direction, i - rec_i, self.ctx["atr_m5"])
        if m is not None:
            s.mss = m.to_dict()
            s.stage = MSS_DONE

    def _stage_displacement(self, s: Setup, m5, times, i, ext_i) -> None:
        cfg = self.cfg.displacement
        mss_i = _idx(times, s.mss["break_time"])
        d = find_displacement(m5, ext_i, min(i, mss_i + cfg.max_bars_after_mss), s.direction, cfg)
        if d is not None:
            s.displacement = d.to_dict()
            s.stage = DISPLACED
        elif i >= mss_i + cfg.max_bars_after_mss:
            self._end(s, NO_TRADE, "structure shifted without qualifying displacement", m5[i].time)

    def _entry_price(self, fvg: FVG) -> float:
        mode = self.cfg.entry.mode
        if mode in ("limit_ce", "confirmation"):
            # confirmation: the real entry is the confirming close; CE is the planning
            # estimate and R is re-validated at the actual entry price.
            return fvg.mid
        # proximal edge: the side of the gap price returns to first
        return fvg.bottom if fvg.direction == "SELL" else fvg.top

    def _stage_fvg(self, s: Setup, m5, times, i, ext_i, levels) -> None:
        cfg = self.cfg.fvg
        cur = m5[i]
        mss_i = _idx(times, s.mss["break_time"])
        last_third = min(i, mss_i + cfg.max_bars_after_mss)
        cands = find_fvgs(m5, ext_i, last_third, s.direction, cfg, self.ctx["atr_m5"], self.ctx["point"])
        cands = [f for f in cands if not touched_since(m5, f, self._entry_price(f))]
        f = select_fvg(cands)
        if f is None:
            if i >= mss_i + cfg.max_bars_after_mss:
                self._end(s, NO_TRADE, "no valid (unfilled) fair value gap from the displacement", cur.time)
            return
        s.fvg = f.to_dict()
        s.fvg_selected_time = cur.time
        entry = self._entry_price(f)
        sl = compute_sl(s.direction, s.sweep["extreme_price"], self.ctx["atr_m5"], self.ctx["spread"],
                        self.ctx["point"], self.cfg.risk)
        plan = build_plan(s.direction, entry, sl, levels, self.ctx["atr_m5"], self.ctx["atr_h1"],
                          self.ctx["point"], self.cfg.risk)
        s.plan = plan.to_dict()
        if not plan.valid:
            s.failed_stage = "R"
            self._end(s, NO_TRADE, "; ".join(plan.reasons), cur.time)
            return
        s.stage, s.status = RETRACE, "WAITING_RETRACEMENT"
        self._provisional_score(s, cur)

    def _provisional_score(self, s: Setup, cur: Candle) -> None:
        """Score with the information known now (assumes a CE fill); final score is set at entry."""
        self._score(s, s.plan["tp2_rr"], self.sessions.active(cur.time), ce_reached=self.cfg.entry.mode != "limit_edge")
        s.score_provisional = True

    def _stage_retrace(self, s: Setup, m5, times, i, levels, feed_live) -> None:
        cur = m5[i]
        sell = s.direction == "SELL"
        sp = self.ctx["spread"]
        f = FVG(**{k: v for k, v in s.fvg.items() if k != "mid"})
        plan = s.plan
        sel_i = _idx(times, s.fvg_selected_time)
        waited = i - sel_i if sel_i is not None else 10 ** 6
        mode = self.cfg.entry.mode

        # did price run to TP1 without retracing? -> do not chase
        tp1 = plan.get("tp1")
        if tp1 is not None and ((sell and cur.low + sp <= tp1) or (not sell and cur.high >= tp1)):
            touched = (sell and cur.high >= plan["entry"]) or (not sell and cur.low + sp <= plan["entry"])
            if not touched:
                self._end(s, INVALIDATED, "price reached TP1 without retracing into the entry zone (not chasing)", cur.time)
                return

        if mode in ("limit_ce", "limit_edge"):
            entry = plan["entry"]
            filled = (sell and cur.high >= entry) or (not sell and cur.low + sp <= entry)
            if not filled:
                if waited >= self.cfg.entry.retrace_max_bars:
                    self._end(s, EXPIRED, f"no retracement into the FVG within {self.cfg.entry.retrace_max_bars} bars", cur.time)
                return
            self._enter(s, cur, entry, levels, feed_live, fill_bar_inclusive=True)
            return

        # confirmation mode
        zone_hit = (sell and cur.high >= f.bottom) or (not sell and cur.low + sp <= f.top)
        if zone_hit:
            s.zone_touched = True
        closed_through = (sell and cur.close > f.top) or (not sell and cur.close < f.bottom)
        if zone_hit and closed_through:
            self._end(s, INVALIDATED, "candle closed through the FVG (zone failed)", cur.time)
            return
        confirm = zone_hit and ((sell and cur.bearish) or (not sell and cur.bullish))
        if confirm:
            entry = cur.close if sell else cur.close + sp   # BUY fills at ask
            self._enter(s, cur, entry, levels, feed_live, fill_bar_inclusive=False)
            return
        if waited >= self.cfg.entry.retrace_max_bars:
            self._end(s, EXPIRED, f"no confirmed retracement within {self.cfg.entry.retrace_max_bars} bars", cur.time)

    # ----------------------------------------------------------------- entry
    def _enter(self, s: Setup, cur: Candle, entry: float, levels, feed_live: bool,
               fill_bar_inclusive: bool) -> None:
        sell = s.direction == "SELL"
        # re-validate R against liquidity that is still untaken right now
        plan = build_plan(s.direction, entry, s.plan["sl"], levels, self.ctx["atr_m5"],
                          self.ctx["atr_h1"], self.ctx["point"], self.cfg.risk)
        s.plan = plan.to_dict()
        s.entry_time, s.entry_price = cur.time, entry
        active = self.sessions.active(cur.time)
        s.session = "/".join(active) if active else "Off-session"
        s.bias = dict(self.ctx["bias"])

        fl = self.cfg.filters
        filters = {}
        filters["rr"] = {"ok": plan.valid, "detail": "; ".join(plan.reasons) or f"TP2 {plan.tp2_rr:.2f}R"}
        allowed = set(fl.allowed_entry_sessions or [])
        filters["session"] = {"ok": (not allowed) or bool(allowed & set(active)),
                              "detail": f"entry during {s.session}"}
        h1 = self.ctx["bias"]["H1"]
        want = "bearish" if sell else "bullish"
        against = "bullish" if sell else "bearish"
        if fl.htf_mode == "aligned":
            ok = h1 == want
        elif fl.htf_mode == "not_opposed":
            ok = h1 != against
        else:
            ok = True
        filters["htf"] = {"ok": ok, "detail": f"H1 {h1}, M15 {self.ctx['bias']['M15']} ({fl.htf_mode})"}
        blocked = [title for (t, title) in self._news
                   if t - fl.news_block_before_min * 60 <= cur.time <= t + fl.news_block_after_min * 60]
        filters["news"] = {"ok": not blocked,
                           "detail": ("blocked: " + ", ".join(blocked)) if blocked else
                           (f"{len(self._news)} manual events, none near" if self._news else "manual news list is empty"),
                           "configured": bool(self._news)}
        filters["feed"] = {"ok": feed_live, "detail": "MT5 feed live" if feed_live else "feed not live"}
        if self.one_trade_at_a_time:
            open_taken = [t for t in self.trades if t.taken]
            filters["exposure"] = {"ok": not open_taken,
                                   "detail": "no open A+ trade" if not open_taken else "an A+ trade is already open"}
        s.filters = filters

        f = s.fvg
        ce_reached = (cur.high >= f["mid"]) if sell else (cur.low <= f["mid"])
        self._score(s, plan.tp2_rr if plan.valid else 0.0, active, ce_reached)
        s.score_provisional = False
        mandatory_ok = all(v["ok"] for v in filters.values())
        if not mandatory_ok:
            s.grade = "FILTERED"
            s.reasons.append("entry rejected: " + "; ".join(f"{k}: {v['detail']}" for k, v in filters.items() if not v["ok"]))
        elif s.score_total < self.cfg.score.a_plus_threshold:
            s.grade = "BELOW_THRESHOLD"
            s.reasons.append(f"score {s.score_total} < A+ threshold {self.cfg.score.a_plus_threshold}")
        else:
            s.grade = "A+"
        s.taken = s.grade == "A+"

        if not plan.valid:
            # without a valid plan there is nothing to track
            s.failed_stage = "R"
            self._end(s, NO_TRADE, "R no longer valid at entry", cur.time)
            return
        s.stage = TRADE
        s.status = "SIGNAL" if s.taken else NO_TRADE
        s.trade = self._new_trade(s, plan)
        if fill_bar_inclusive:
            self._update_trade(s, cur, self.ctx["spread"], fill_bar=True)

    def _score(self, s: Setup, tp2_rr: float, active: list, ce_reached: bool) -> None:
        comps = {
            "liquidity": scoring.score_liquidity(s.sweep["level"]),
            "sweep": scoring.score_sweep(s.sweep),
            "mss": scoring.score_mss(s.mss, s.displacement),
            "displacement": scoring.score_displacement(s.displacement),
            "fvg": scoring.score_fvg(s.fvg, first_touch=True, ce_reached=ce_reached),
            "htf": scoring.score_htf(self.ctx["bias"]["H1"], self.ctx["bias"]["M15"], s.direction),
            "rr": scoring.score_rr(tp2_rr),
            "session": scoring.score_session(active),
        }
        s.score, s.score_total = comps, scoring.total(comps)

    # ---------------------------------------------------------------- trades
    def _new_trade(self, s: Setup, plan) -> dict:
        risk = plan.risk
        sell = s.direction == "SELL"
        targets = {"TP1": plan.tp1, "TP2": plan.tp2}
        for r in R_EXITS:
            targets[f"{r:g}R"] = s.entry_price - r * risk if sell else s.entry_price + r * risk
        return {"risk": risk, "targets": targets,
                "outcomes": {k: {"status": "open", "time": None, "r": None} for k in targets},
                "mfe": 0.0, "mae": 0.0, "mfe_r": 0.0, "mae_r": 0.0, "bars": 0,
                "result": "open", "r_result": None, "exit_time": None, "exit_price": None,
                "sl_hit": False, "tp1_hit": False}

    def _update_trade(self, s: Setup, cur: Candle, spread: float, fill_bar: bool = False) -> bool:
        tr = s.trade
        if not tr or tr["result"] != "open":
            return False
        if not fill_bar and s.entry_time is not None and cur.time <= s.entry_time:
            return False
        sell = s.direction == "SELL"
        e, risk = s.entry_price, tr["risk"]
        sl = s.plan["sl"]
        tr["bars"] += 0 if fill_bar else 1
        if sell:
            fav, adv = e - (cur.low + spread), (cur.high + spread) - e
            sl_hit = cur.high + spread >= sl
        else:
            fav, adv = cur.high - e, e - cur.low
            sl_hit = cur.low <= sl
        if not fill_bar:
            tr["mfe"] = max(tr["mfe"], fav)
        tr["mae"] = max(tr["mae"], min(adv, risk) if sl_hit else adv)
        tr["mfe_r"], tr["mae_r"] = tr["mfe"] / risk, tr["mae"] / risk

        for name, price in tr["targets"].items():
            o = tr["outcomes"][name]
            if o["status"] != "open" or price is None:
                continue
            if sl_hit:
                o.update(status="loss", time=cur.time, r=-1.0)
                continue
            if fill_bar:
                continue   # conservative: no targets on the fill candle
            hit = (cur.low + spread <= price) if sell else (cur.high >= price)
            if hit:
                o.update(status="win", time=cur.time, r=abs(price - e) / risk)
        if tr["outcomes"]["TP1"]["status"] == "win":
            tr["tp1_hit"] = True

        done = sl_hit or all(o["status"] != "open" for o in tr["outcomes"].values())
        if not done and tr["bars"] >= self.cfg.entry.max_hold_bars:
            mtm = ((e - (cur.close + spread)) if sell else (cur.close - e)) / risk
            for o in tr["outcomes"].values():
                if o["status"] == "open":
                    o.update(status="timeout", time=cur.time, r=mtm)
            done = True
        if done:
            main = tr["outcomes"]["TP2"]
            tr["result"] = {"win": "WIN", "loss": "LOSS", "timeout": "TIMEOUT"}.get(main["status"], "TIMEOUT")
            tr["r_result"] = main["r"]
            tr["sl_hit"] = sl_hit
            tr["exit_time"] = cur.time
            tr["exit_price"] = sl if main["status"] == "loss" else (
                tr["targets"]["TP2"] if main["status"] == "win" else cur.close)
            s.stage, s.status, s.ended_time = ENDED, CLOSED, cur.time
        return True

    # ------------------------------------------------------------ UI state
    def describe(self) -> dict:
        """Full UI state: levels, current setup, checklist, steps, plan, score."""
        ctx = self.ctx
        cur_setup = self.setup
        trade = next((t for t in reversed(self.trades) if t.taken), None) or \
            (self.trades[-1] if self.trades else None)
        recent = self.history[-1] if self.history else None
        focus = cur_setup or trade
        if focus is None and recent is not None and ctx and recent.ended_time is not None \
                and ctx["time"] - recent.ended_time <= 12 * 300:
            focus = recent
        live_levels = [l for l in self.levels if l.is_live()]
        return {
            "bar_time": ctx.get("time"),
            "now": ctx.get("now"),
            "atr_m5": ctx.get("atr_m5"),
            "atr_h1": ctx.get("atr_h1"),
            "bias": ctx.get("bias", {}),
            "sessions_active": ctx.get("sessions", []),
            "levels": [l.to_dict() for l in self.levels],
            "setup": focus.to_dict() if focus else None,
            "label": _label(focus),
            "checklist": _checklist(focus, live_levels, self.cfg),
            "steps": _steps(focus, bool(live_levels)),
            "open_trades": [t.to_dict() for t in self.trades],
            "recent": [h.to_dict() for h in self.history[-10:]][::-1],
            "threshold": self.cfg.score.a_plus_threshold,
        }


# ---------------------------------------------------------------- UI helpers
def _label(s: Optional[Setup]) -> dict:
    if s is None:
        return {"text": "WAITING", "kind": "waiting", "detail": "No sweep of recognised liquidity yet"}
    if s.stage in (SWEPT, MSS_DONE, DISPLACED):
        nxt = {SWEPT: "waiting for M5 structure shift", MSS_DONE: "waiting for displacement",
               DISPLACED: "waiting for a valid FVG"}[s.stage]
        return {"text": "SETUP FORMING", "kind": "forming", "detail": f"{s.direction}: {nxt}"}
    if s.stage == RETRACE:
        return {"text": "WAITING FOR RETRACEMENT", "kind": "retrace",
                "detail": f"{s.direction}: limit/confirmation in FVG – not chasing"}
    if s.stage == TRADE:
        if s.taken:
            return {"text": f"A+ {s.direction}", "kind": "signal", "detail": f"score {s.score_total}"}
        return {"text": "NO TRADE", "kind": "notrade", "detail": s.reasons[-1] if s.reasons else ""}
    # ended
    if s.status == CLOSED:
        tr = s.trade
        txt = f"{'A+ ' if s.taken else ''}{s.direction} {tr.get('result', '')}"
        return {"text": txt, "kind": "closed",
                "detail": f"{tr.get('r_result') or 0:+.2f}R" + ("" if s.taken else " (not an A+ signal)")}
    kind = "invalidated" if s.status == INVALIDATED else "notrade"
    text = "INVALIDATED" if s.status == INVALIDATED else "NO TRADE"
    return {"text": text, "kind": kind, "detail": s.reasons[-1] if s.reasons else ""}


def _checklist(s: Optional[Setup], live_levels, cfg: StrategyConfig) -> list[dict]:
    def item(key, label, state, detail=""):
        return {"key": key, "label": label, "state": state, "detail": detail}
    out = []
    if s is None:
        out.append(item("liquidity", "Liquidity identified", "pass" if live_levels else "pending",
                        f"{len(live_levels)} live levels"))
        for key, label in (("sweep", "Sweep confirmed"), ("mss", "M5 structure shift (MSS)"),
                           ("displacement", "Displacement"), ("fvg", "Valid FVG"),
                           ("retrace", "Retracement into zone"), ("htf", "H1/M15 alignment"),
                           ("rr", f"R accepted (>= 1:{cfg.risk.min_rr:g})"), ("session", "Session filter"),
                           ("news", "News filter")):
            out.append(item(key, label, "pending"))
        return out
    failed = s.failed_stage
    out.append(item("liquidity", "Liquidity identified", "pass", s.sweep["level"]["label"]))
    out.append(item("sweep", "Sweep confirmed", "pass",
                    f"{s.sweep['level_price']:.2f} swept to {s.sweep['extreme_price']:.2f}"))
    def st(done, stage_key):
        if done:
            return "pass"
        return "fail" if failed == stage_key else "pending"
    out.append(item("mss", "M5 structure shift (MSS)", st(s.mss is not None, SWEPT),
                    f"close through {s.mss['level']:.2f}" if s.mss else ""))
    out.append(item("displacement", "Displacement", st(s.displacement is not None, MSS_DONE),
                    f"{s.displacement['best_body_atr']:.2f}xATR ({s.displacement['rule']})" if s.displacement else ""))
    fvg_fail = failed == DISPLACED
    out.append(item("fvg", "Valid FVG", "pass" if s.fvg else ("fail" if fvg_fail else "pending"),
                    f"{s.fvg['bottom']:.2f}-{s.fvg['top']:.2f}" if s.fvg else ""))
    out.append(item("retrace", "Retracement into zone", "pass" if s.entry_time else
                    ("fail" if failed == RETRACE else "pending"),
                    f"filled {s.entry_price:.2f}" if s.entry_price else ""))
    f = s.filters or {}
    def fil(key, label):
        if key not in f:
            return item(key, label, "pending")
        state = "pass" if f[key]["ok"] else "fail"
        if key == "news" and f[key]["ok"] and not f[key].get("configured"):
            state = "warn"
        return item(key, label, state, f[key]["detail"])
    out.append(fil("htf", "H1/M15 alignment"))
    if "rr" in f:
        out.append(fil("rr", f"R accepted (>= 1:{cfg.risk.min_rr:g})"))
    elif s.plan:
        ok = s.plan.get("valid")
        out.append(item("rr", f"R accepted (>= 1:{cfg.risk.min_rr:g})", "pass" if ok else "fail",
                        f"TP2 {s.plan.get('tp2_rr', 0):.2f}R" if ok else "; ".join(s.plan.get("reasons", []))))
    else:
        out.append(item("rr", f"R accepted (>= 1:{cfg.risk.min_rr:g})", "pending"))
    out.append(fil("session", "Session filter"))
    out.append(fil("news", "News filter"))
    return out


def _steps(s: Optional[Setup], have_levels: bool) -> list[dict]:
    names = ["Liquidity", "Sweep", "MSS", "Displacement", "Retracement", "Entry", "Target"]
    states = ["done" if have_levels else "current"] + ["locked"] * 6
    if s is None:
        if have_levels:
            states[1] = "current"
        return [{"name": n, "state": st} for n, st in zip(names, states)]
    entered = s.entry_time is not None
    done_flags = [True, True, s.mss is not None, s.displacement is not None,
                  entered, entered and s.taken,
                  bool(s.trade) and s.taken and s.trade.get("result") == "WIN"]
    states = ["done" if d else "locked" for d in done_flags]
    first_open = next((i for i, d in enumerate(done_flags) if not d), None)
    if first_open is not None:
        if s.stage == ENDED:
            states[first_open] = "failed"
        else:
            states[first_open] = "current"
    if s.stage == RETRACE:
        states[4] = "current"
    if entered and not s.taken:
        states[5], states[6] = "failed", "locked"   # zone filled but filters/score rejected the entry
    return [{"name": n, "state": st} for n, st in zip(names, states)]


def clone_engine(e: StrategyEngine) -> StrategyEngine:
    return copy.deepcopy(e)
