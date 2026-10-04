"""Live service: MT5 terminal -> normalized candles -> strategy engine -> clients.

Feed status values
  CONNECTING     – starting up
  LIVE           – terminal connected and ticks are arriving
  STALE          – connected, market should be open, but no new tick for
                   ``feed.stale_seconds`` (no new signals are evaluated)
  MARKET_CLOSED  – no ticks because the market is in its weekly/daily break
  RECONNECTING   – terminal lost its broker connection or a call failed; retrying
  OFFLINE        – MT5 terminal not running / package missing / initialize failed

Signals are only evaluated while the feed is LIVE.  When the feed returns,
bars that closed in the meantime are processed from MT5 history in order (the
same as a backtest would), so the state machine never skips a candle.
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Optional

from .config import AppConfig
from .models import Candle, TIMEFRAMES, TF_SECONDS
from .mt5_client import MT5Client, rank_symbols
from .sessions import MarketHours, SessionDef, SessionEngine
from .signal_log import SignalLog
from .strategy.engine import StrategyEngine
from .strategy.market import MarketStore
from .strategy.plan import position_size
from .timeutil import ServerClock, iso_utc, measure_offset

log = logging.getLogger("xau.live")

FETCH_COUNTS = {"M5": 1500, "M15": 600, "H1": 400, "H4": 200, "D1": 30}
WARMUP_BARS = 576          # replay the last 2 days of M5 bars through the engine at start-up

LIVE, STALE, MARKET_CLOSED, RECONNECTING, OFFLINE, CONNECTING = (
    "LIVE", "STALE", "MARKET_CLOSED", "RECONNECTING", "OFFLINE", "CONNECTING")
# Closed candles may be evaluated while LIVE, or while the market is closed (no new
# candles can form then, history is complete).  Never while STALE/RECONNECTING/OFFLINE.
EVAL_OK = (LIVE, MARKET_CLOSED)


def offset_transitions(clock: ServerClock, start: int, end: int) -> list[list[int]]:
    """[[utc_from, offset_seconds], ...] so the UI can show server time exactly."""
    out = [[start, clock.offset_at_utc(start)]]
    t = start
    while t < end:
        nxt = t + 86400
        if clock.offset_at_utc(nxt) != out[-1][1]:
            h = t
            while h < nxt and clock.offset_at_utc(h) == out[-1][1]:
                h += 900
            out.append([h, clock.offset_at_utc(h)])
        t = nxt
    return out


def candle_json(c: Candle) -> dict:
    return {"t": c.time, "o": c.open, "h": c.high, "l": c.low, "c": c.close, "v": c.tick_volume, "s": c.spread}


class LiveService:
    def __init__(self, cfg: AppConfig, mt5_module: Any, log_db: Optional[SignalLog] = None,
                 wall: Callable[[], float] = time.time, mono: Callable[[], float] = time.monotonic):
        self.cfg = cfg
        self.mt5_module = mt5_module
        self.wall, self.mono = wall, mono
        self.mt5_exec = ThreadPoolExecutor(1, thread_name_prefix="mt5")    # MT5 lib is not thread-safe
        self.cpu_exec = ThreadPoolExecutor(1, thread_name_prefix="engine")
        self.log_db = log_db
        self._lock = threading.Lock()
        self.listeners: set = set()          # objects with async send(dict) and .tf
        self._reset_runtime()

    # ---------------------------------------------------------------- setup
    def _reset_runtime(self) -> None:
        cfg = self.cfg
        self.clock = ServerClock(cfg.feed.server_timezone)
        self.sessions = SessionEngine([SessionDef(**s) for s in cfg.sessions])
        self.market_hours = MarketHours()
        self.client = MT5Client(self.mt5_module, self.clock, cfg.feed.terminal_path)
        self.status, self.status_detail = CONNECTING, "starting"
        self.symbol: Optional[str] = None
        self.spec = None
        self.account = None
        self.terminal: dict = {}
        self.candidates: list[str] = []
        self.tick = None
        self.tick_raw: Optional[int] = None
        self.last_tick_msc: Optional[int] = None
        self.last_change_mono: Optional[float] = None
        self.detected_offset: Optional[int] = None
        self.fail_count = 0
        self.next_connect_mono = 0.0
        self.last_forming_m5: Optional[int] = None
        self.last_bar_poll = 0.0
        self.last_slow_poll = 0.0
        self.last_status_push = 0.0
        self.last_paused_refresh = -1e9
        self.store = MarketStore()
        self._new_engine()

    def _new_engine(self) -> None:
        self.engine = StrategyEngine(self.cfg.strategy, self.sessions, symbol=self.symbol or "XAUUSD")
        self.strategy_state: dict = self.engine.describe()
        self.engine_paused_reason = ""

    def apply_config(self, cfg: AppConfig) -> None:
        old = self.cfg
        self.cfg = cfg
        reconnect = (old.feed.server_timezone != cfg.feed.server_timezone or
                     old.feed.symbol_override != cfg.feed.symbol_override or
                     old.feed.terminal_path != cfg.feed.terminal_path or old.sessions != cfg.sessions)
        if reconnect:
            try:
                self.client.shutdown()
            except Exception:
                pass
            listeners = self.listeners
            self._reset_runtime()
            self.listeners = listeners
        elif old.strategy != cfg.strategy:
            self._new_engine()
            self.last_forming_m5 = None     # forces re-fetch + warm-up with the new rules

    # ------------------------------------------------------------- helpers
    async def _mt5(self, fn, *args):
        return await asyncio.get_running_loop().run_in_executor(self.mt5_exec, fn, *args)

    async def broadcast(self, msg: dict) -> None:
        dead = []
        for l in list(self.listeners):
            try:
                if msg.get("type") == "bar" and getattr(l, "tf", None) != msg.get("tf"):
                    continue
                await l.send(msg)
            except Exception:
                dead.append(l)
        for d in dead:
            self.listeners.discard(d)

    def _set_status(self, status: str, detail: str = "") -> bool:
        changed = (status, detail) != (self.status, self.status_detail)
        self.status, self.status_detail = status, detail
        return changed

    # ------------------------------------------------------------ main loop
    async def run_forever(self) -> None:
        while True:
            await self.run_once()
            await asyncio.sleep(self.cfg.feed.poll_interval_ms / 1000.0)

    async def run_once(self) -> None:
        try:
            await self.step()
        except asyncio.CancelledError:
            raise
        except Exception as e:     # never die; report and reconnect
            log.warning("live loop error: %s: %s", type(e).__name__, e)
            await self._on_failure(f"{type(e).__name__}: {e}")

    async def _on_failure(self, detail: str) -> None:
        try:
            await self._mt5(self.client.shutdown)
        except Exception:
            pass
        self.fail_count += 1
        self.last_change_mono = None
        self.last_tick_msc = None
        self.next_connect_mono = self.mono() + min(10.0, 0.5 * 2 ** min(self.fail_count, 5))
        st = RECONNECTING if self.fail_count <= 3 else OFFLINE
        self._set_status(st, detail)
        await self.push_status(force=True)

    async def _connect(self) -> None:
        if self.mono() < self.next_connect_mono:
            return
        if self.fail_count:
            self._set_status(RECONNECTING if self.fail_count <= 3 else OFFLINE, "reconnecting to MT5 …")
        ok = await self._mt5(self.client.connect)
        if not ok:
            await self._on_failure(self.client.last_error)
            return
        sym = self.cfg.feed.symbol_override.strip()
        if sym:
            if not await self._mt5(self.client.select, sym):
                await self._on_failure(f"symbol '{sym}' not available at this broker – choose another")
                return
            self.candidates = await self._mt5(lambda: rank_symbols(
                self.client.all_symbol_names(), self.cfg.feed.symbol_candidates))
        else:
            sym, self.candidates = await self._mt5(self.client.detect_symbol, self.cfg.feed.symbol_candidates)
            if not sym:
                await self._on_failure("no XAUUSD/GOLD symbol detected – select one manually in Settings")
                return
        self.symbol = sym
        self.engine.symbol = sym
        self.spec = await self._mt5(self.client.spec, sym)
        self.store.spec = self.spec
        self.account = await self._mt5(self.client.account)
        self.terminal = await self._mt5(self.client.terminal_state)
        self.fail_count = 0
        self.last_forming_m5 = None
        self._set_status(CONNECTING, "connected – waiting for first tick")
        await self.broadcast({"type": "snapshot", **self.full_state()})

    async def step(self) -> None:
        if not self.client.connected:
            await self._connect()
            if not self.client.connected:
                await self.push_status()
                return
        mono, wall = self.mono(), self.wall()
        self.terminal = await self._mt5(self.client.terminal_state)
        if not self.terminal["connected"]:
            self.last_change_mono = None
            self._set_status(RECONNECTING, "MT5 terminal is not connected to the broker server")
            await self.push_status()
            return

        res = await self._mt5(self.client.tick, self.symbol)
        if res is not None:
            tick, raw = res
            if tick.time_msc != self.last_tick_msc:
                first = self.last_tick_msc is None
                self.last_tick_msc = tick.time_msc
                if first:
                    age = wall - tick.time   # relies on configured server-time rule
                    self.last_change_mono = (mono - max(age, 0.0)) if -5 < age < self.cfg.feed.stale_seconds else None
                else:
                    self.last_change_mono = mono
                    self.detected_offset = measure_offset(raw, wall)
                self.tick, self.tick_raw = tick, raw
                if self.last_change_mono is not None:
                    await self.broadcast({"type": "tick", **self.tick_json()})

        age = (mono - self.last_change_mono) if self.last_change_mono is not None else None
        if age is not None and age <= self.cfg.feed.stale_seconds:
            self._set_status(LIVE, "")
        elif not self.market_hours.is_open(int(wall)):
            self._set_status(MARKET_CLOSED, "market is in its weekly/daily break – no live ticks")
        else:
            self._set_status(STALE, f"no new tick for {age:.0f}s" if age is not None else
                             "no fresh tick received since connecting")

        if mono - self.last_bar_poll >= 0.5:
            self.last_bar_poll = mono
            await self._poll_bars()
        if mono - self.last_slow_poll >= 5:
            self.last_slow_poll = mono
            self.account = await self._mt5(self.client.account)
            self.spec = await self._mt5(self.client.spec, self.symbol) or self.spec
            self.store.spec = self.spec
        await self.push_status()

    async def _poll_bars(self) -> None:
        last2 = await self._mt5(self.client.rates, self.symbol, "M5", 2)
        if last2:
            forming = last2[-1].time
            if forming != self.last_forming_m5:
                can_eval = self.status in EVAL_OK
                # while the feed is not usable, re-check at most every 10s
                if can_eval or self.mono() - self.last_paused_refresh >= 10:
                    self.last_paused_refresh = self.mono()
                    if await self._refresh_and_evaluate():
                        self.last_forming_m5 = forming
        if self.status == LIVE:
            for tf in {getattr(l, "tf", None) for l in self.listeners} - {None}:
                bars = await self._mt5(self.client.rates, self.symbol, tf, 2)
                if bars:
                    await self.broadcast({"type": "bar", "tf": tf, "candles": [candle_json(c) for c in bars]})

    async def _refresh_and_evaluate(self) -> bool:
        for tf, n in FETCH_COUNTS.items():
            self.store.set_bars(tf, await self._mt5(self.client.rates, self.symbol, tf, n))
        self.store.spec = self.spec
        if self.status not in EVAL_OK:
            self.engine_paused_reason = f"strategy paused: feed {self.status}"
            await self.broadcast({"type": "strategy", "strategy": self.strategy_payload()})
            return False
        self.engine_paused_reason = ""
        now = self.tick.time if self.tick else self.store.bars["M5"][-1].time
        await asyncio.get_running_loop().run_in_executor(self.cpu_exec, self._process, now)
        await self.broadcast({"type": "strategy", "strategy": self.strategy_payload()})
        return True

    def _process(self, now: int) -> None:
        with self._lock:
            eng = self.engine
            closes = [ct for ct in self.store.m5_close_times() if ct <= now]
            if eng.last_bar_time is None:
                closes = closes[-WARMUP_BARS:]
            else:
                closes = [ct for ct in closes if ct > eng.last_bar_time + 300]
            for ct in closes:
                for ev in eng.on_bar(self.store.snapshot_at(ct), feed_live=True):
                    if self.log_db is not None:
                        self.log_db.upsert(ev)
            self.strategy_state = eng.describe()

    # --------------------------------------------------------------- output
    def tick_json(self) -> dict:
        t = self.tick
        if t is None:
            return {}
        point = self.spec.point if self.spec else 0.01
        return {"time": t.time, "time_msc": t.time_msc, "server_raw": self.tick_raw, "bid": t.bid, "ask": t.ask,
                "last": t.last, "spread_points": t.spread_points(point), "spread_price": round(t.ask - t.bid, 5)}

    def balance(self) -> tuple[float, str]:
        a = self.cfg.account
        if a.balance_source == "mt5" and self.account is not None:
            return self.account.balance, f"MT5 account balance ({self.account.currency})"
        return a.manual_balance, "manual balance"

    def strategy_payload(self) -> dict:
        with self._lock:
            st = dict(self.strategy_state)
        st["paused_reason"] = self.engine_paused_reason
        setup = st.get("setup")
        bal, src = self.balance()
        st["sizing"] = None
        if setup and setup.get("plan") and setup["plan"].get("risk"):
            st["sizing"] = position_size(bal, self.cfg.account.risk_percent, setup["plan"]["risk"], self.spec)
            st["sizing"]["balance_source"] = src
        return st

    def status_json(self) -> dict:
        now = int(self.wall())
        age = (self.mono() - self.last_change_mono) if self.last_change_mono is not None else None
        cfg_off = self.clock.offset_at_utc(now)
        warn = []
        if self.detected_offset is not None and self.detected_offset != cfg_off:
            warn.append(f"Broker server offset measured as GMT{self.detected_offset/3600:+g} but setting "
                        f"'{self.clock.rule}' gives GMT{cfg_off/3600:+g}. Fix feed.server_timezone, "
                        f"otherwise session/Asia/day boundaries are wrong.")
        if self.status != LIVE:
            warn.append("Prices are NOT live – nothing on screen is a current quote.")
        return {
            "status": self.status, "detail": self.status_detail, "symbol": self.symbol,
            "candidates": self.candidates, "tick_age": None if age is None else round(age, 1),
            "stale_seconds": self.cfg.feed.stale_seconds, "now_utc": now,
            "server_offset_configured": cfg_off, "server_offset_detected": self.detected_offset,
            "server_rule": self.clock.rule,
            "sessions": self.sessions.describe(now), "market_open": self.market_hours.is_open(now),
            "terminal": self.terminal, "account": self.account.to_dict() if self.account else None,
            "warnings": warn,
        }

    async def push_status(self, force: bool = False) -> None:
        m = self.mono()
        if force or m - self.last_status_push >= 1.0:
            self.last_status_push = m
            await self.broadcast({"type": "status", **self.status_json()})

    def full_state(self) -> dict:
        now = int(self.wall())
        return {
            "status": self.status_json(),
            "tick": self.tick_json() if self.status == LIVE else {},
            "spec": self.spec.to_dict() if self.spec else None,
            "strategy": self.strategy_payload(),
            "settings": {"risk_percent": self.cfg.account.risk_percent,
                         "balance_source": self.cfg.account.balance_source,
                         "manual_balance": self.cfg.account.manual_balance,
                         "min_rr": self.cfg.strategy.risk.min_rr,
                         "threshold": self.cfg.strategy.score.a_plus_threshold,
                         "entry_mode": self.cfg.strategy.entry.mode},
            "tz": offset_transitions(self.clock, now - 6 * 365 * 86400, now + 2 * 86400),
        }

    async def chart_candles(self, tf: str, count: int) -> list[dict]:
        if tf not in TIMEFRAMES or not self.client.connected or not self.symbol:
            return []
        bars = await self._mt5(self.client.rates, self.symbol, tf, count)
        return [candle_json(c) for c in bars]


def dumps(o: Any) -> str:
    return json.dumps(o, default=str, separators=(",", ":"))


__all__ = ["LiveService", "offset_transitions", "LIVE", "STALE", "OFFLINE", "RECONNECTING", "MARKET_CLOSED",
           "iso_utc", "TF_SECONDS"]
