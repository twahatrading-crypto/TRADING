"""Real-MT5 validation tool.  Run on the Windows PC with MetaTrader 5 open:

    python -m xau.validate preflight      # connection, account (no login), symbol, broker spec
    python -m xau.validate timezone       # measure broker server offset (live ticks + history), sessions
    python -m xau.validate ohlc           # dashboard/app candles vs raw MT5 for M1..D1
    python -m xau.validate levels         # Asia H/L, PDH/PDL, swings: engine vs independent raw recompute
    python -m xau.validate statemachine   # real-data setup paths incl. rejections/invalidations
    python -m xau.validate live           # (dashboard running) ticks, candle updates, exactly-once M5 processing
    python -m xau.validate disconnect     # (dashboard running) guided stale / disconnect / reconnect test
    python -m xau.validate baseline       # export real history, frozen BASELINE backtest (default rules)
    python -m xau.validate tests          # run the automated test-suite and record the result
    python -m xau.validate report         # write docs/real-mt5-validation.md + completion gate

Evidence goes to docs/validation/*.json.  Evidence produced by anything other
than the real ``MetaTrader5`` package (e.g. the test double) is marked
SYNTHETIC and can never tick a completion-gate item.  No login number,
password or balance is ever written.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import socket
import statistics
import struct
import subprocess
import sys
import time
from collections import Counter, defaultdict
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from zoneinfo import ZoneInfo

from .config import ROOT, AppConfig, load_config
from .models import TF_SECONDS, TIMEFRAMES
from .mt5_client import MT5Client, load_mt5_module
from .sessions import SessionDef, SessionEngine
from .strategy.market import MarketStore
from .strategy.plan import position_size
from .timeutil import ServerClock, measure_offset

EVIDENCE = ROOT / "docs" / "validation"
BASELINE_DIR = ROOT / "docs" / "baseline"
REPORT = ROOT / "docs" / "real-mt5-validation.md"
TZ_FILE = ROOT / "data" / "tz_verification.json"
DASH = "http://127.0.0.1:8765"
CANDIDATE_RULES = ["NY+7", "Europe/Athens", "Europe/London", "UTC", "fixed:+2", "fixed:+3"]


# ------------------------------------------------------------------ helpers
def utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso(ts: Optional[float]) -> Optional[str]:
    return None if ts is None else datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def srv(ts_raw: Optional[int]) -> Optional[str]:
    """Format a raw MT5 server timestamp as the wall time MT5 itself shows."""
    return None if ts_raw is None else datetime.fromtimestamp(ts_raw, timezone.utc).strftime("%Y-%m-%d %H:%M")


def git_commit() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True,
                              timeout=10).stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def rel(p: Path) -> str:
    try:
        return str(Path(p).relative_to(ROOT))
    except ValueError:
        return str(p)


def save(name: str, data: dict) -> Path:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    p = EVIDENCE / f"{name}.json"
    p.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
    print(f"  -> evidence written: {rel(p)}")
    return p


def load(name: str) -> Optional[dict]:
    p = EVIDENCE / f"{name}.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def provenance(module: Any, client: Optional[MT5Client] = None) -> dict:
    name = getattr(module, "__name__", type(module).__name__)
    real = name == "MetaTrader5"
    out = {"data_source": "REAL MT5 DATA" if real else "TEST/SYNTHETIC DATA (not MetaTrader5)",
           "real_mt5": real, "mt5_package": name,
           "mt5_package_version": getattr(module, "__version__", None),
           "generated_utc": utcnow_iso(), "git_commit": git_commit(),
           "python": platform.python_version(), "os": f"{platform.system()} {platform.release()}"}
    try:
        out["terminal_version"] = list(module.version()) if real else None
    except Exception:
        pass
    return out


def connect(cfg: AppConfig, module: Any = None) -> tuple[Any, MT5Client, str]:
    module = module if module is not None else load_mt5_module()
    if module is None:
        raise SystemExit("[ERROR] MetaTrader5 package missing. Run start.bat once (it installs requirements).")
    client = MT5Client(module, ServerClock(cfg.feed.server_timezone), cfg.feed.terminal_path)
    if not client.connect():
        raise SystemExit(f"[ERROR] {client.last_error}\n  -> Open MetaTrader 5, log in, wait for quotes, run again.")
    sym = cfg.feed.symbol_override or client.detect_symbol(cfg.feed.symbol_candidates)[0]
    if not sym:
        raise SystemExit("[ERROR] no gold symbol detected. Add XAUUSD/GOLD to Market Watch or set the symbol in Settings.")
    client.select(sym)
    return module, client, sym


def raw_rates(client: MT5Client, sym: str, tf: str, count: int) -> list[dict]:
    r = client.mt5.copy_rates_from_pos(sym, client.tf_const(tf), 0, int(count))
    if r is None:
        return []
    return [{"time": int(x["time"]), "open": float(x["open"]), "high": float(x["high"]), "low": float(x["low"]),
             "close": float(x["close"]), "tick_volume": int(x["tick_volume"]), "spread": int(x["spread"])} for x in r]


def http_json(url: str, timeout: float = 5.0) -> Optional[Any]:
    import urllib.request
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def sntp_offset(host: str = "time.windows.com", timeout: float = 3.0) -> Optional[float]:
    """PC clock error vs an NTP server (seconds, + = PC is ahead). None if unreachable."""
    try:
        pkt = b"\x1b" + 47 * b"\0"
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(timeout)
            t0 = time.time()
            s.sendto(pkt, (host, 123))
            data, _ = s.recvfrom(512)
            t1 = time.time()
        secs, frac = struct.unpack("!II", data[40:48])
        server_t = secs - 2208988800 + frac / 2 ** 32
        return round(((t0 + t1) / 2) - server_t, 3)
    except Exception:
        return None


# --------------------------------------------------------------- preflight
SPEC_FIELDS = ["name", "description", "digits", "point", "trade_tick_size", "trade_tick_value",
               "trade_tick_value_profit", "trade_tick_value_loss", "trade_contract_size", "volume_min",
               "volume_max", "volume_step", "volume_limit", "currency_base", "currency_profit",
               "currency_margin", "spread", "spread_float", "trade_mode", "trade_calc_mode",
               "trade_stops_level", "trade_freeze_level", "path"]


def phase_preflight(cfg: AppConfig, module: Any = None) -> dict:
    module, client, sym = connect(cfg, module)
    try:
        ti = client.mt5.terminal_info()
        acc = client.account()
        si = client.mt5.symbol_info(sym)
        tick = client.mt5.symbol_info_tick(sym)
        spec = client.spec(sym)
        names = client.all_symbol_names()
        from .mt5_client import rank_symbols
        gold_like = [n for n in names if any(k in n.upper() for k in ("XAU", "GOLD"))]
        raw_spec = {f: getattr(si, f, None) for f in SPEC_FIELDS}
        example = position_size(10000.0, 0.5, 3.00, spec)
        out = {
            **provenance(module, client),
            "terminal": {"name": getattr(ti, "name", ""), "company": getattr(ti, "company", ""),
                         "build": getattr(ti, "build", None),
                         "connected_to_broker": bool(getattr(ti, "connected", False)),
                         "trade_allowed_in_terminal": bool(getattr(ti, "trade_allowed", False))},
            "account": {"server": acc.server if acc else None, "company": acc.company if acc else None,
                        "type": acc.trade_mode if acc else None, "currency": acc.currency if acc else None,
                        "note": "login number, password and balance intentionally not recorded"},
            "symbol": {"detected": sym, "auto_detect": not cfg.feed.symbol_override,
                       "ranked_candidates": rank_symbols(names, cfg.feed.symbol_candidates),
                       "all_gold_like_symbols_at_broker": gold_like},
            "broker_spec_raw": raw_spec,
            "spec_used_by_app": spec.to_dict(),
            "tick": {"bid": getattr(tick, "bid", None), "ask": getattr(tick, "ask", None),
                     "spread_points": round((tick.ask - tick.bid) / si.point, 1) if tick else None,
                     "server_time": srv(getattr(tick, "time", None)),
                     "time_msc_raw": getattr(tick, "time_msc", None)},
            "position_size_example": {"inputs": "balance 10000, risk 0.5%, SL distance 3.00",
                                      **example},
        }
        mismatch = []
        if spec.tick_size != (raw_spec["trade_tick_size"] or raw_spec["point"]):
            mismatch.append("tick_size")
        if spec.volume_step != raw_spec["volume_step"]:
            mismatch.append("volume_step")
        out["spec_consistency"] = "OK" if not mismatch else f"MISMATCH: {mismatch}"
        print(f"  terminal {out['terminal']['name']} build {out['terminal']['build']}, broker connection "
              f"{'OK' if out['terminal']['connected_to_broker'] else 'DOWN'}")
        print(f"  account server {out['account']['server']} ({out['account']['type']})  symbol {sym}")
        print(f"  digits {si.digits} point {si.point} tick_size {raw_spec['trade_tick_size']} tick_value "
              f"{raw_spec['trade_tick_value']} contract {raw_spec['trade_contract_size']} vol "
              f"{si.volume_min}-{si.volume_max} step {si.volume_step}")
        save("preflight", out)
        return out
    finally:
        client.shutdown()


# ---------------------------------------------------------------- timezone
def weekly_open_analysis(h1_raw: list[dict], rules=CANDIDATE_RULES) -> dict:
    """For each weekend gap in H1 history, express the first bar of the week in
    New York time under every candidate rule.  Gold's weekly open is anchored to
    New York (Sunday ~18:00 NY), so the correct rule gives one constant NY open
    hour across both DST regimes, while a rule with the wrong DST dates flips by
    1h in the weeks where US and EU clocks disagree."""
    opens = []
    for i in range(1, len(h1_raw)):
        if h1_raw[i]["time"] - h1_raw[i - 1]["time"] > 30 * 3600:
            opens.append(h1_raw[i]["time"])
    ny = ZoneInfo("America/New_York")
    per_rule = {}
    for rule in rules:
        clk = ServerClock(rule)
        hours = []
        for raw in opens:
            u = clk.to_utc(raw)
            loc = datetime.fromtimestamp(u, timezone.utc).astimezone(ny)
            hours.append((loc.strftime("%a"), loc.hour))
        cnt = Counter(hours)
        mode, n = cnt.most_common(1)[0] if cnt else ((None, None), 0)
        per_rule[rule] = {"weeks": len(hours), "modal_ny_open": f"{mode[0]} {mode[1]:02d}:00" if mode[0] else None,
                          "weeks_at_mode": n, "consistency": round(n / len(hours), 4) if hours else None}
    # weeks where candidate rules disagree are the ones that discriminate DST conventions
    disc = []
    for raw in opens:
        offs = {r: ServerClock(r).offset_at_utc(ServerClock(r).to_utc(raw)) for r in ("NY+7", "Europe/Athens")}
        if len(set(offs.values())) > 1:
            disc.append(srv(raw))
    return {"weekly_opens_found": len(opens), "first": srv(opens[0]) if opens else None,
            "last": srv(opens[-1]) if opens else None, "per_rule": per_rule,
            "dst_discriminating_weeks": disc,
            "assumption": "gold's weekly open is anchored to New York time (Sunday ~18:00 NY)"}


def phase_timezone(cfg: AppConfig, module: Any = None, seconds: float = 90.0, sleep=time.sleep) -> dict:
    module, client, sym = connect(cfg, module)
    rule = cfg.feed.server_timezone
    clk = ServerClock(rule)
    try:
        print(f"  sampling live ticks for {seconds:.0f}s (market must be open) ...")
        samples, last_msc, t_end = [], None, time.time() + seconds
        while time.time() < t_end:
            t = client.mt5.symbol_info_tick(sym)
            wall = time.time()
            if t is not None and t.time_msc != last_msc:
                if last_msc is not None:                      # count only CHANGES (fresh ticks)
                    samples.append(t.time_msc / 1000.0 - wall)
                last_msc = t.time_msc
            sleep(0.2)
        ntp = sntp_offset()
        live = {"tick_changes": len(samples)}
        if samples:
            med = statistics.median(samples)
            off = measure_offset(int(round(med)), 0)
            live.update(measured_offset_s=off, measured_gmt=f"GMT{off / 3600:+g}",
                        residual_median_s=round(med - off, 2),
                        residual_min_s=round(min(samples) - off, 2), residual_max_s=round(max(samples) - off, 2))
        live["pc_clock_minus_ntp_s"] = ntp
        now = time.time()
        live["rule"] = rule
        live["rule_offset_now_s"] = clk.offset_at_utc(int(now))
        live["matches_rule"] = bool(samples) and live["measured_offset_s"] == live["rule_offset_now_s"]
        if samples and not live["matches_rule"]:
            live["rules_matching_measurement"] = [r for r in CANDIDATE_RULES
                                                  if ServerClock(r).offset_at_utc(int(now)) == live["measured_offset_s"]]
        h1 = raw_rates(client, sym, "H1", 30000)
        hist = weekly_open_analysis(h1)
        rule_hist = hist["per_rule"].get(rule) or {}
        best = max(hist["per_rule"].items(), key=lambda kv: (kv[1]["consistency"] or 0))[0] if hist["per_rule"] else None

        # boundaries for the most recent completed trading day
        sessions = SessionEngine([SessionDef(**s) for s in cfg.sessions])
        d1 = raw_rates(client, sym, "D1", 5)
        prev_day = d1[-2] if len(d1) >= 2 else None
        bounds = {}
        ref = int(now)
        for name in ("Asian", "London", "New York"):
            w = sessions.last_completed(name, ref)
            if w:
                bounds[name] = {"utc": f"{iso(w[0])} -> {iso(w[1])}",
                                "server_time": f"{srv(clk.to_server(w[0]))} -> {srv(clk.to_server(w[1]))}",
                                "local": f"{sessions.by_name[name].start}-{sessions.by_name[name].end} {sessions.by_name[name].tz}"}
        if prev_day:
            u0 = clk.to_utc(prev_day["time"])
            bounds["previous_trading_day_D1"] = {"server_date": srv(prev_day["time"])[:10],
                                                 "utc": f"{iso(u0)} -> {iso(u0 + 86400)}",
                                                 "new_york": datetime.fromtimestamp(u0, timezone.utc)
                                                 .astimezone(ZoneInfo('America/New_York')).strftime('%a %H:%M NY'),
                                                 "high": prev_day["high"], "low": prev_day["low"]}
        clock_ok = ntp is None or abs(ntp) < 5
        verdict = "VERIFIED" if (live["matches_rule"] and len(samples) >= 10 and clock_ok
                                 and (rule_hist.get("consistency") or 0) >= 0.95) else (
            "MISMATCH" if samples and not live["matches_rule"] else "NOT VERIFIED")
        reasons = []
        if not samples:
            reasons.append("no live tick changes observed (market closed?) - rerun while gold is trading")
        if samples and len(samples) < 10:
            reasons.append("fewer than 10 tick changes")
        if not clock_ok:
            reasons.append(f"PC clock is off by {ntp:+.1f}s vs NTP - sync Windows time and rerun")
        if (rule_hist.get("consistency") or 0) < 0.95:
            reasons.append(f"history: rule '{rule}' gives a constant NY weekly-open hour in only "
                           f"{(rule_hist.get('consistency') or 0) * 100:.0f}% of weeks; best rule: {best}")
        out = {**provenance(module, client), "symbol": sym, "live_measurement": live,
               "history_weekly_open": hist, "best_history_rule": best,
               "session_boundaries_last_completed": bounds, "verdict": verdict, "reasons": reasons}
        print(f"  live: {live.get('measured_gmt', 'n/a')} from {len(samples)} tick changes; rule '{rule}' "
              f"-> GMT{live['rule_offset_now_s'] / 3600:+g}; history consistency "
              f"{rule_hist.get('consistency')} (best {best}); NTP {ntp}")
        print(f"  VERDICT: {verdict} {'; '.join(reasons)}")
        if verdict == "VERIFIED" and out["real_mt5"]:
            acc = client.account()
            TZ_FILE.parent.mkdir(parents=True, exist_ok=True)
            TZ_FILE.write_text(json.dumps({"server": acc.server if acc else None, "rule": rule,
                                           "verdict": "VERIFIED", "verified_at": utcnow_iso(),
                                           "method": "live tick offset + weekly-open history"}, indent=2))
        save("timezone", out)
        return out
    finally:
        client.shutdown()


# -------------------------------------------------------------------- OHLC
def phase_ohlc(cfg: AppConfig, module: Any = None, bars: int = 6) -> dict:
    module, client, sym = connect(cfg, module)
    clk = client.clock
    try:
        dash_state = http_json(f"{DASH}/api/state")
        source = "dashboard /api/candles (running app)" if dash_state else "app MT5 adapter (dashboard not running)"
        result = {}
        for tf in TIMEFRAMES:
            raw = raw_rates(client, sym, tf, bars)
            if dash_state:
                app = (http_json(f"{DASH}/api/candles?tf={tf}&count={bars + 2}") or {}).get("candles", [])
                app = [{"t": c["t"], "o": c["o"], "h": c["h"], "l": c["l"], "c": c["c"]} for c in app]
            else:
                app = [{"t": c.time, "o": c.open, "h": c.high, "l": c.low, "c": c.close} for c in client.rates(sym, tf, bars)]
            by_t = {clk.to_server(c["t"]): c for c in app}
            rows, ok = [], True
            point = (client.spec(sym).point if client.spec(sym) else 0.01)
            for i, r in enumerate(raw):
                forming = i == len(raw) - 1
                a = by_t.get(r["time"])
                match = a is not None and all(abs(a[k] - r[n]) <= point / 2 for k, n in
                                              (("o", "open"), ("h", "high"), ("l", "low"), ("c", "close")))
                if not forming and not match:
                    ok = False
                rows.append({"server_time": srv(r["time"]), "utc": iso(clk.to_utc(r["time"])), "forming": forming,
                             "mt5": [r["open"], r["high"], r["low"], r["close"]],
                             "app": [a["o"], a["h"], a["l"], a["c"]] if a else None,
                             "match": match if not forming else (match or "forming bar (may tick between reads)")})
            result[tf] = {"verified": ok and len(raw) > 1, "rows": rows}
            print(f"  {tf:>3}: {'MATCH' if result[tf]['verified'] else 'MISMATCH'} ({len(raw) - 1} closed bars compared)")
        out = {**provenance(module, client), "symbol": sym, "app_source": source, "timeframes": result,
               "manual_check": "Open MT5 Data Window (Ctrl+D) on each timeframe and compare the last closed "
                               "candle with the table; record a screenshot in docs/validation/screenshots/."}
        save("ohlc", out)
        return out
    finally:
        client.shutdown()


# ------------------------------------------------------------------ levels
def _fractals(rows: list[dict], k: int) -> tuple[list[tuple[int, float]], list[tuple[int, float]]]:
    """Independent fractal implementation on RAW MT5 rows (server time)."""
    hs, ls = [], []
    for i in range(k, len(rows) - k):
        h, l = rows[i]["high"], rows[i]["low"]
        if all(h > rows[j]["high"] for j in range(i - k, i)) and all(h >= rows[j]["high"] for j in range(i + 1, i + k + 1)):
            hs.append((rows[i]["time"], h))
        if all(l < rows[j]["low"] for j in range(i - k, i)) and all(l <= rows[j]["low"] for j in range(i + 1, i + k + 1)):
            ls.append((rows[i]["time"], l))
    return hs, ls


def phase_levels(cfg: AppConfig, module: Any = None) -> dict:
    from .live import FETCH_COUNTS
    from .strategy.indicators import atr
    from .strategy.liquidity import _asia_levels, _pd_levels, _swing_levels
    module, client, sym = connect(cfg, module)
    clk = client.clock
    try:
        spec = client.spec(sym)
        tick = spec.tick_size or spec.point
        store = MarketStore(bars={tf: client.rates(sym, tf, n) for tf, n in FETCH_COUNTS.items()}, spec=spec)
        sessions = SessionEngine([SessionDef(**s) for s in cfg.sessions])
        last_tick = client.tick(sym)
        now = last_tick[0].time if last_tick else store.bars["M5"][-1].time
        win = sessions.last_completed("Asian", now)
        T = win[1] + 300 if win else now                     # evaluate just after the last completed Asian session
        snap = store.snapshot_at(T)
        eng = {l.kind: l for l in _pd_levels(snap) + _asia_levels(snap, cfg.strategy.liquidity, sessions)}
        rows = []

        def cmp(name, engine_val, expected, note):
            diff = None if engine_val is None or expected is None else abs(engine_val - expected)
            rows.append({"level": name, "expected_independent": expected, "engine": engine_val,
                         "diff_ticks": None if diff is None else round(diff / tick, 2),
                         "pass": diff is not None and diff <= tick + 1e-9, "method": note})

        # PDH/PDL: engine uses the D1 candle; independent = max/min of raw M1 over that server day
        d1 = snap.bars["D1"][-1] if snap.bars.get("D1") else None
        if d1:
            day_raw0 = clk.to_server(d1.time)
            m1 = client.mt5.copy_rates_range(sym, client.tf_const("M1"),
                                             datetime.fromtimestamp(day_raw0, timezone.utc),
                                             datetime.fromtimestamp(day_raw0 + 86400 - 60, timezone.utc))
            m1 = [x for x in (m1 if m1 is not None else []) if day_raw0 <= int(x["time"]) < day_raw0 + 86400]
            exp_h = max((float(x["high"]) for x in m1), default=None)
            exp_l = min((float(x["low"]) for x in m1), default=None)
            note = f"raw M1 max/min over server day {srv(day_raw0)[:10]} ({len(m1)} M1 bars)"
            cmp("PDH", eng["PDH"].price if "PDH" in eng else None, exp_h, note)
            cmp("PDL", eng["PDL"].price if "PDL" in eng else None, exp_l, note)
        # Asia: engine uses M5 + configured rule; independent = raw M1 in the window mapped with the MEASURED offset
        tzev = load("timezone") or {}
        meas = (tzev.get("live_measurement") or {}).get("measured_offset_s")
        if win:
            off = meas if meas is not None else clk.offset_at_utc(win[0])
            a_raw, b_raw = win[0] + off, win[1] + off
            m1 = client.mt5.copy_rates_range(sym, client.tf_const("M1"), datetime.fromtimestamp(a_raw, timezone.utc),
                                             datetime.fromtimestamp(b_raw, timezone.utc))
            m1 = [x for x in (m1 if m1 is not None else []) if a_raw <= int(x["time"]) < b_raw]
            note = (f"raw M1 in Asian window {srv(a_raw)}->{srv(b_raw)} server time, mapped with "
                    f"{'MEASURED' if meas is not None else 'RULE'} offset GMT{off / 3600:+g} ({len(m1)} M1 bars)")
            cmp("Asia High", eng["ASIA_HIGH"].price if "ASIA_HIGH" in eng else None,
                max((float(x["high"]) for x in m1), default=None), note)
            cmp("Asia Low", eng["ASIA_LOW"].price if "ASIA_LOW" in eng else None,
                min((float(x["low"]) for x in m1), default=None), note)
        # swings: engine (UTC path) vs independent fractals on raw rows (server time)
        L = cfg.strategy.liquidity
        swings = []
        for tf, k, lb, prefix in (("M15", L.swing_strength_m15, L.m15_swing_lookback_bars, "M15"),
                                  ("H1", L.swing_strength_h1, L.h1_swing_lookback_bars, "H1")):
            e = _swing_levels(snap, tf, k, lb, prefix)
            closed = [r for r in raw_rates(client, sym, tf, FETCH_COUNTS[tf])
                      if clk.to_utc(r["time"]) + TF_SECONDS[tf] <= T][-lb:]
            ih, il = _fractals(closed, k)
            ind = {(t, p, "HIGH") for t, p in ih} | {(t, p, "LOW") for t, p in il}
            eng_set = {(clk.to_server(l.source_time), l.price, "HIGH" if l.side == "high" else "LOW") for l in e}
            for (t, p, side) in sorted(eng_set | ind)[-12:]:
                swings.append({"tf": tf, "side": side, "server_time": srv(t), "price": p,
                               "engine": (t, p, side) in eng_set, "independent": (t, p, side) in ind})
        swings_ok = all(s["engine"] and s["independent"] for s in swings) if swings else False
        out = {**provenance(module, client), "symbol": sym, "evaluated_at_utc": iso(T),
               "evaluated_at_server": srv(clk.to_server(T)), "tick_size": tick,
               "levels": rows, "swings_last_12_per_tf": swings, "swings_agree": swings_ok,
               "atr_m5": round(atr(snap.m5(), 14), 3),
               "manual_check": ("On the MT5 chart, put the crosshair on the candles listed and confirm each price. "
                                "Fill the 'MT5 chart (manual)' column in docs/real-mt5-validation.md.")}
        for r in rows:
            print(f"  {r['level']:<10} engine {r['engine']}  independent {r['expected_independent']}  "
                  f"diff {r['diff_ticks']} ticks  {'PASS' if r['pass'] else 'FAIL'}")
        print(f"  swings engine vs independent: {'AGREE' if swings_ok else 'DIFFER'} ({len(swings)} compared)")
        save("levels", out)
        return out
    finally:
        client.shutdown()


# ------------------------------------------------------------ state machine
def classify(s: dict) -> str:
    st, fs = s.get("status"), s.get("failed_stage")
    if s.get("entry_time"):
        g = s.get("grade")
        res = (s.get("trade") or {}).get("result", "open")
        return f"ENTRY -> {g} -> {res}"
    if st in ("NO_TRADE", "INVALIDATED", "EXPIRED"):
        path = ["SWEEP"] + (["MSS"] if s.get("mss") else []) + (["DISPLACEMENT"] if s.get("displacement") else []) \
               + (["FVG"] if s.get("fvg") else [])
        reason = (s.get("reasons") or [""])[-1]
        key = reason.split(";")[0][:70]
        return f"{' -> '.join(path)} -> {st} ({key})"
    return f"IN PROGRESS at {s.get('stage')}"


def phase_statemachine(cfg: AppConfig, module: Any = None, days: int = 30) -> dict:
    from .backtest import make_sessions, run_backtest
    module, client, sym = connect(cfg, module)
    clk = client.clock
    try:
        end = (client.tick(sym) or (None,))[0]
        end_t = end.time if end else int(time.time())
        start = end_t - days * 86400
        bars = {tf: client.rates_range(sym, tf, start - 15 * 86400, end_t) for tf in ("M5", "M15", "H1", "H4", "D1")}
        store = MarketStore(bars=bars, spec=client.spec(sym))
        _, setups = run_backtest(store, AppConfig().strategy, make_sessions(cfg), start, end_t)
        cats = defaultdict(list)
        for s in setups:
            cats[classify(s)].append(s)
        examples = {}
        for k, v in sorted(cats.items(), key=lambda kv: -len(kv[1])):
            examples[k] = {"count": len(v), "examples": [{
                "id": s["id"], "direction": s["direction"],
                "liquidity": f"{s['sweep']['level']['label']} {s['sweep']['level_price']}",
                "sweep_server_time": srv(clk.to_server(s["sweep"]["sweep_time"])),
                "mss_server_time": srv(clk.to_server(s["mss"]["break_time"])) if s.get("mss") else None,
                "entry_server_time": srv(clk.to_server(s["entry_time"])) if s.get("entry_time") else None,
                "rr": (s.get("plan") or {}).get("tp2_rr"), "score": s.get("score_total"),
                "reasons": s.get("reasons")} for s in v[:3]]}
        paths_seen = {
            "full_chain_to_entry": any(k.startswith("ENTRY") for k in cats),
            "sweep_then_no_mss": any(k.startswith("SWEEP -> EXPIRED") or k.startswith("SWEEP -> INVALIDATED")
                                     or k.startswith("SWEEP -> NO_TRADE") for k in cats),
            "rejected_for_R": any("liquidity target" in k or "SL" in k for k in cats),
            "no_chasing_invalidation": any("without retracing" in k for k in cats),
        }
        out = {**provenance(module, client), "symbol": sym, "window_utc": f"{iso(start)} -> {iso(end_t)}",
               "rules": "default StrategyConfig (unchanged)", "setups_total": len(setups),
               "paths": examples, "paths_seen": paths_seen}
        print(f"  {len(setups)} setups over {days} days:")
        for k, v in examples.items():
            print(f"   {v['count']:>4}  {k}")
        save("statemachine", out)
        return out
    finally:
        client.shutdown()


# -------------------------------------------------------------- live watch
async def _watch_dashboard(seconds: float, on_status=None) -> dict:
    import websockets
    ticks, bars, strategies, statuses = [], [], [], []
    async with websockets.connect(DASH.replace("http", "ws") + "/ws", max_size=None) as ws:
        t_end = time.time() + seconds
        while time.time() < t_end:
            try:
                m = json.loads(await asyncio_wait(ws.recv(), max(0.1, t_end - time.time())))
            except Exception:
                continue
            now = time.time()
            if m["type"] == "tick":
                ticks.append({"recv": now, "time_msc": m["time_msc"], "bid": m["bid"], "ask": m["ask"]})
            elif m["type"] == "bar":
                bars.append({"recv": now, "tf": m["tf"], "last": m["candles"][-1]})
            elif m["type"] == "strategy":
                strategies.append({"recv": now, "label": m["strategy"].get("label"),
                                   "bar_time": m["strategy"].get("bar_time"),
                                   "paused": m["strategy"].get("paused_reason")})
            elif m["type"] in ("status", "snapshot"):
                st = m if m["type"] == "status" else m["status"]
                if not statuses or statuses[-1]["status"] != st["status"]:
                    statuses.append({"recv": now, "status": st["status"], "detail": st.get("detail")})
                    if on_status:
                        on_status(st)
    return {"ticks": ticks, "bars": bars, "strategies": strategies, "statuses": statuses}


def asyncio_wait(coro, timeout):
    import asyncio
    return asyncio.wait_for(coro, timeout)


def _audit_check(audit: dict, mt5_closes: list[int], t0: float, t1: float) -> dict:
    proc = [e for e in audit.get("recent", []) if t0 <= e["processed_wall"] <= t1 and not e["warmup"]]
    pc = [e["bar_close_utc"] for e in proc]
    expected = [c for c in mt5_closes if min(pc, default=0) <= c <= max(pc, default=0)] if pc else []
    return {"processed_in_window": len(pc), "processed_bar_closes_utc": [iso(c) for c in pc],
            "duplicates": len(pc) - len(set(pc)), "in_order": pc == sorted(pc),
            "missing_vs_mt5": [iso(c) for c in expected if c not in set(pc)],
            "lookahead_violations": sum(1 for e in proc if e["bar_close_utc"] > e["evaluated_at_tick_utc"]),
            "processing_delay_s": [round(e["processed_wall"] - e["bar_close_utc"], 2) for e in proc],
            "engine_counters": audit.get("stats")}


def phase_live(cfg: AppConfig, module: Any = None, minutes: float = 12.0) -> dict:
    import asyncio
    if not http_json(f"{DASH}/api/state"):
        raise SystemExit("[ERROR] dashboard not running. Start start.bat in another window first.")
    module, client, sym = connect(cfg, module)     # independent MT5 connection for cross-checks
    try:
        t0 = time.time()
        print(f"  watching dashboard for {minutes:.0f} min (needs >= 2 M5 closes; keep gold market open) ...")
        w = asyncio.run(_watch_dashboard(minutes * 60))
        t1 = time.time()
        audit = http_json(f"{DASH}/api/audit") or {}
        m5 = [client.clock.to_utc(r["time"]) + 300 for r in raw_rates(client, sym, "M5", 200)[:-1]]
        bids = [x["bid"] for x in w["ticks"]]
        lat = [round(x["recv"] - x["time_msc"] / 1000.0, 3) for x in w["ticks"]]
        m5_updates = [b for b in w["bars"] if b["tf"] == "M5"]
        distinct_m5 = sorted({b["last"]["t"] for b in m5_updates})
        chk = _audit_check(audit, m5, t0, t1)
        out = {**provenance(module, client), "symbol": sym, "window_utc": f"{iso(t0)} -> {iso(t1)}",
               "ticks_received_by_dashboard": len(w["ticks"]), "bid_changes": sum(1 for a, b in zip(bids, bids[1:]) if a != b),
               "tick_to_dashboard_latency_s": {"median": statistics.median(lat) if lat else None,
                                               "max": max(lat) if lat else None},
               "current_candle_updates": len(m5_updates),
               "m5_candles_seen_forming": [iso(t) for t in distinct_m5],
               "m5_closes_observed": max(0, len(distinct_m5) - 1),
               "strategy_updates": [{"at": iso(s["recv"]), "bar": iso(s["bar_time"]), "label": (s["label"] or {}).get("text"),
                                     "paused": s["paused"]} for s in w["strategies"]],
               "status_timeline": [{"at": iso(s["recv"]), **{k: v for k, v in s.items() if k != "recv"}} for s in w["statuses"]],
               "exactly_once": chk}
        passed = (out["ticks_received_by_dashboard"] > 0 and out["bid_changes"] > 0 and out["m5_closes_observed"] >= 1
                  and chk["processed_in_window"] >= 1 and chk["duplicates"] == 0 and not chk["missing_vs_mt5"]
                  and chk["lookahead_violations"] == 0 and chk["in_order"])
        out["verified"] = passed
        print(f"  ticks {out['ticks_received_by_dashboard']}, bid changes {out['bid_changes']}, M5 closes "
              f"{out['m5_closes_observed']}, processed {chk['processed_in_window']}, duplicates {chk['duplicates']}, "
              f"missing {len(chk['missing_vs_mt5'])}, look-ahead {chk['lookahead_violations']} -> "
              f"{'PASS' if passed else 'NOT PROVEN'}")
        save("live", out)
        return out
    finally:
        client.shutdown()


def phase_disconnect(cfg: AppConfig, module: Any = None) -> dict:
    import asyncio
    import threading
    if not http_json(f"{DASH}/api/state"):
        raise SystemExit("[ERROR] dashboard not running. Start start.bat in another window first.")
    print("  Guided test. Keep this window and the dashboard visible.")
    input("  1) Confirm the dashboard shows MT5 LIVE, then press Enter ... ")
    t0 = time.time()
    seen: list[dict] = []
    stop = threading.Event()

    def watch():
        while not stop.is_set():
            st = http_json(f"{DASH}/api/state", timeout=3)
            if st:
                s = st["status"]
                if not seen or seen[-1]["status"] != s["status"]:
                    seen.append({"at": iso(time.time()), "wall": time.time(), "status": s["status"], "detail": s["detail"],
                                 "paused": st["strategy"].get("paused_reason")})
                    print(f"     [{iso(time.time())}] {s['status']}  {s['detail'] or ''}")
            time.sleep(1)

    th = threading.Thread(target=watch, daemon=True)
    th.start()
    input("  2) Now DISCONNECT: unplug network / disable Wi-Fi (or close MT5). Wait until the dashboard shows\n"
          "     DATA STALE / RECONNECTING / OFFLINE and stay disconnected >= 6 minutes (>= one M5 close). Press Enter ... ")
    t_dis = time.time()
    input("  3) Now RECONNECT network (or reopen MT5 and log in). Wait for MT5 LIVE, then press Enter ... ")
    time.sleep(5)
    stop.set()
    th.join(timeout=3)
    t1 = time.time()
    audit = http_json(f"{DASH}/api/audit") or {}
    signals = http_json(f"{DASH}/api/signals?limit=200") or []
    non_live = [s for s in seen if s["status"] not in ("LIVE",)]
    out_start = min((s["wall"] for s in non_live), default=None)
    back = [s for s in seen if s["status"] == "LIVE" and out_start and s["wall"] > out_start]
    out_end = back[0]["wall"] if back else None
    during = [e for e in audit.get("recent", []) if out_start and out_end and out_start < e["processed_wall"] < out_end]
    after = [e for e in audit.get("recent", []) if out_end and e["processed_wall"] >= out_end]
    module_, client, sym = connect(cfg, module)
    try:
        m5 = [client.clock.to_utc(r["time"]) + 300 for r in raw_rates(client, sym, "M5", 200)[:-1]]
        outage_closes = [c for c in m5 if out_start and out_end and out_start <= c <= out_end]
        caught = {e["bar_close_utc"] for e in after}
        out = {**provenance(module_, client), "timeline": seen,
               "outage_utc": f"{iso(out_start)} -> {iso(out_end)}",
               "states_seen": sorted({s["status"] for s in seen}),
               "bars_processed_while_not_live": len(during),
               "signals_created_while_not_live": [s["id"] for s in signals
                                                  if out_start and out_end and s.get("created_utc")
                                                  and out_start < s["created_utc"] + 300 < out_end],
               "m5_closes_during_outage": [iso(c) for c in outage_closes],
               "caught_up_after_reconnect": [iso(c) for c in outage_closes if c in caught],
               "not_caught_up": [iso(c) for c in outage_closes if c not in caught],
               "audit_counters": audit.get("stats")}
        out["verified_stale_protection"] = bool(non_live) and not during and not out["signals_created_while_not_live"]
        out["verified_reconnect_catch_up"] = bool(out_end) and bool(outage_closes) and not out["not_caught_up"]
        print(f"  states: {out['states_seen']}; processed while not live: {len(during)}; outage closes "
              f"{len(outage_closes)}, caught up {len(out['caught_up_after_reconnect'])}")
        save("disconnect", out)
        return out
    finally:
        client.shutdown()


# ---------------------------------------------------------------- baseline
def config_hash(d: dict) -> str:
    return hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest()[:16]


def phase_baseline(cfg: AppConfig, module: Any = None, years: float = 5.0) -> dict:
    from .backtest import compute_stats, make_sessions, run_backtest, save_csv, save_spec
    BASELINE_DIR.mkdir(parents=True, exist_ok=True)
    frozen = BASELINE_DIR / "BASELINE.json"
    if frozen.exists():
        raise SystemExit(f"[STOP] {rel(frozen)} already exists and is FROZEN. It is never overwritten. "
                         f"Alternative thresholds must be run as separate, named experiments.")
    module, client, sym = connect(cfg, module)
    try:
        defaults = AppConfig().strategy
        user_strategy = cfg.to_dict()["strategy"]
        if user_strategy != AppConfig().to_dict()["strategy"]:
            print("  NOTE: your settings.json strategy differs from the defaults; BASELINE uses the DEFAULTS.")
        end_tick = client.tick(sym)
        end = int(end_tick[0].time) if end_tick else int(time.time())
        end = end // 86400 * 86400                                     # last completed UTC day
        start_all = end - int(years * 365 * 86400)
        hist_dir = ROOT / "data" / "history" / "".join(ch if ch.isalnum() else "_" for ch in (client.account().server if client.account() else "broker"))
        print(f"  exporting real history -> {rel(hist_dir)} ...")
        bars = {}
        for tf in ("M5", "M15", "H1", "H4", "D1"):
            bars[tf] = client.rates_range(sym, tf, start_all - 15 * 86400, end)
            save_csv(hist_dir / f"{sym}_{tf}.csv", bars[tf])
            print(f"   {tf}: {len(bars[tf])} candles from {iso(bars[tf][0].time) if bars[tf] else '-'}")
        spec = client.spec(sym)
        save_spec(hist_dir / f"{sym}_spec.json", spec)
        store = MarketStore(bars=bars, spec=spec)
        first_m5 = bars["M5"][0].time if bars["M5"] else end
        periods = [("1 month", 30), ("3 months", 91), ("1 year", 365), ("all available M5 history", None)]
        results = {}
        for name, days in periods:
            p_start = end - days * 86400 if days else first_m5 + 15 * 86400
            if p_start < first_m5 + 10 * 86400:
                results[name] = {"skipped": f"M5 history only starts {iso(first_m5)} – raise MT5 'Max bars in chart'"}
                print(f"  {name}: skipped (not enough M5 history)")
                continue
            print(f"  running {name}: {iso(p_start)} -> {iso(end)} ...")
            _, setups = run_backtest(store, defaults, make_sessions(cfg), p_start, end)
            st = compute_stats(setups)
            st["window_utc"] = f"{iso(p_start)} -> {iso(end)}"
            st["executed_signals"] = st["overall"].get("trades", 0)
            results[name] = st
            o = st["overall"]
            print(f"   setups {st['setups_total']}, executed {o.get('trades', 0)}, win rate "
                  f"{(o.get('win_rate') or 0) * 100:.1f}%, expectancy {o.get('expectancy_r')}R, PF {o.get('profit_factor')}")
        out = {**provenance(module, client), "label": "BASELINE", "frozen": True, "symbol": sym,
               "broker_server": client.account().server if client.account() else None,
               "strategy_config": AppConfig().to_dict()["strategy"],
               "strategy_config_hash": config_hash(AppConfig().to_dict()["strategy"]),
               "history_csv_dir": str(rel(hist_dir)),
               "m5_history_start": iso(first_m5), "end_utc": iso(end), "periods": results,
               "note": "Default rules, no tuning. Past results only; not evidence of future profitability."}
        if out["real_mt5"]:
            frozen.write_text(json.dumps(out, indent=2, default=str), encoding="utf-8")
            (BASELINE_DIR / "BASELINE.md").write_text(baseline_markdown(out), encoding="utf-8")
            print(f"  -> FROZEN: {rel(frozen)}")
        save("baseline", out)
        return out
    finally:
        client.shutdown()


def _fmt_stats_row(name: str, v: dict) -> str:
    if not v or not v.get("trades"):
        return f"| {name} | 0 | – | – | – | – | – | – | – | – | – |"
    return (f"| {name} | {v['trades']} | {v['wins']} | {v['losses']} | {v['win_rate'] * 100:.1f}% | "
            f"{v['avg_win_r']:+.2f} | {-v['avg_loss_r']:+.2f} | {v['expectancy_r']:+.3f} | "
            f"{v['profit_factor'] if v['profit_factor'] is not None else '∞'} | {v['max_drawdown_r']:.2f} | "
            f"{v['max_consecutive_losses']} |")


STATS_HEADER = ("| | trades | wins | losses | win rate | avg winner R | avg loser R | expectancy R | PF | max DD R | max consec. losses |\n"
                "|---|---|---|---|---|---|---|---|---|---|---|")


def baseline_markdown(b: dict) -> str:
    L = [f"# BASELINE backtest (frozen) – {b['symbol']} @ {b.get('broker_server')}", "",
         f"*{b['data_source']}* · generated {b['generated_utc']} · commit `{b['git_commit']}` · "
         f"rules hash `{b['strategy_config_hash']}` (defaults, untuned) · M5 history from {b['m5_history_start']}", "",
         "> Past results only. Not evidence of future profitability.", ""]
    for name, st in b["periods"].items():
        L.append(f"## {name}")
        if "skipped" in st:
            L += [st["skipped"], ""]
            continue
        o = st["overall"]
        L += [f"Window {st['window_utc']} · total setups **{st['setups_total']}** · executed A+ signals "
              f"**{st['executed_signals']}** · timeouts {o.get('timeouts', 0)}", "", STATS_HEADER,
              _fmt_stats_row("**All**", o)]
        for k in ("Asian", "London", "New York", "Off-session"):
            L.append(_fmt_stats_row(f"Session: {k}", st["by_session"].get(k, {})))
        for k in ("BUY", "SELL"):
            L.append(_fmt_stats_row(k, st["by_direction"].get(k, {})))
        for k, lab in (("2R", "Exit 1:2"), ("3R", "Exit 1:3"), ("4R", "Exit 1:4"), ("TP2", "Exit liquidity target (TP2)"),
                       ("TP1", "Exit TP1")):
            L.append(_fmt_stats_row(lab, st["exits"].get(k, {})))
        L += ["", "<details><summary>Setup funnel</summary>", "", "| outcome | count |", "|---|---|"]
        L += [f"| {k} | {v} |" for k, v in st["funnel"].items()]
        L += ["", "</details>", ""]
    return "\n".join(L)


# ------------------------------------------------------------------- tests
def phase_tests(cfg: AppConfig, module: Any = None) -> dict:
    r = subprocess.run([sys.executable, "-m", "pytest", "-p", "no:warnings"], cwd=ROOT,
                       capture_output=True, text=True)
    tail = [l for l in r.stdout.strip().splitlines() if l.strip()][-1:] or ["(no output)"]
    out = {"generated_utc": utcnow_iso(), "git_commit": git_commit(), "returncode": r.returncode,
           "summary": tail[0], "platform": f"{platform.system()} {platform.release()}",
           "real_mt5_history_replay_test": "ran" if (ROOT / "tests" / "data" / "real").exists() else "skipped (no export)"}
    print(f"  {out['summary']}")
    save("tests", out)
    return out


# ------------------------------------------------------------------ report
GATE = [
    ("Real MT5 connection", lambda e: _real(e, "preflight") and e["preflight"]["terminal"]["connected_to_broker"]),
    ("Real XAUUSD ticks", lambda e: _real(e, "live") and e["live"]["bid_changes"] > 0),
    ("Real broker specifications", lambda e: _real(e, "preflight") and e["preflight"]["spec_consistency"] == "OK"),
    *[(f"{tf} verified", (lambda tf: lambda e: _real(e, "ohlc") and e["ohlc"]["timeframes"][tf]["verified"])(tf))
      for tf in TIMEFRAMES],
    ("Broker timezone verified", lambda e: _real(e, "timezone") and e["timezone"]["verdict"] == "VERIFIED"),
    ("Asian High/Low verified", lambda e: _real(e, "levels") and all(r["pass"] for r in e["levels"]["levels"] if r["level"].startswith("Asia"))
     and any(r["level"].startswith("Asia") for r in e["levels"]["levels"])),
    ("PDH/PDL verified", lambda e: _real(e, "levels") and all(r["pass"] for r in e["levels"]["levels"] if r["level"] in ("PDH", "PDL"))
     and any(r["level"] == "PDH" for r in e["levels"]["levels"])),
    ("Live candle close processing verified", lambda e: _real(e, "live") and e["live"]["verified"]),
    ("No duplicate candle processing", lambda e: _real(e, "live") and e["live"]["exactly_once"]["duplicates"] == 0
     and e["live"]["exactly_once"]["processed_in_window"] > 0),
    ("STALE protection verified", lambda e: _real(e, "disconnect") and e["disconnect"]["verified_stale_protection"]),
    ("Disconnect/reconnect verified", lambda e: _real(e, "disconnect") and e["disconnect"]["verified_reconnect_catch_up"]),
    ("Same live/backtest engine confirmed", lambda e: e.get("tests") is not None and e["tests"]["returncode"] == 0
     and _real(e, "statemachine")),
    ("Baseline backtest completed", lambda e: (BASELINE_DIR / "BASELINE.json").exists() and _real(e, "baseline")),
    ("81+ existing tests still pass", lambda e: e.get("tests") is not None and e["tests"]["returncode"] == 0
     and _passed(e["tests"]["summary"]) >= 81),
]


def _real(e: dict, k: str) -> bool:
    return bool(e.get(k)) and e[k].get("real_mt5") is True


def _passed(summary: str) -> int:
    try:
        return int(summary.split(" passed")[0].split()[-1])
    except Exception:
        return 0


def _safe(fn, e) -> bool:
    try:
        return bool(fn(e))
    except Exception:
        return False


def phase_report(cfg: AppConfig, module: Any = None) -> str:
    e = {k: load(k) for k in ("preflight", "timezone", "ohlc", "levels", "statemachine", "live", "disconnect",
                              "baseline", "tests")}
    L = ["# Real MT5 validation – evidence", "",
         f"Generated {utcnow_iso()} by `python -m xau.validate report` · commit `{git_commit()}`", "",
         "Every section states its **data source**. Only evidence produced by the real `MetaTrader5` package on the "
         "user's Windows PC counts as **REAL MT5 DATA**. Anything from the automated test-suite is **TEST/SYNTHETIC "
         "DATA** (hand-built candles through an MT5 test double) and never ticks a gate item.", "",
         "## Completion gate", ""]
    done = 0
    for name, fn in GATE:
        ok = _safe(fn, e)
        done += ok
        L.append(f"- [{'x' if ok else ' '}] {name}")
    L += ["", f"**{done}/{len(GATE)} proven.** " + ("Phase complete." if done == len(GATE) else
                                                    "Phase NOT complete – see the PENDING/FAIL items."), ""]

    def section(title, key, body):
        nonlocal L
        L.append(f"## {title}")
        ev = e.get(key)
        if not ev:
            L += ["**PENDING** – run `python -m xau.validate " + key + "` on the Windows PC.", ""]
            return
        L.append(f"*Data source: **{ev.get('data_source', 'n/a')}** · {ev.get('generated_utc', ev.get('generated_utc'))}*")
        L.append("")
        body(ev)
        L.append("")

    def b_pre(p):
        nonlocal L
        L.extend([f"- Terminal: {p['terminal']['name']} build {p['terminal']['build']}, broker connection "
                  f"{'connected' if p['terminal']['connected_to_broker'] else 'NOT connected'}",
                  f"- Broker: {p['account']['company']} · server `{p['account']['server']}` · account type "
                  f"**{p['account']['type']}** · currency {p['account']['currency']} (login/password/balance not recorded)",
                  f"- MT5 package {p.get('mt5_package_version')} · terminal version {p.get('terminal_version')} · {p['os']}",
                  f"- Detected symbol: **`{p['symbol']['detected']}`** (auto-detect: {p['symbol']['auto_detect']}); "
                  f"candidates {p['symbol']['ranked_candidates']}; all gold-like: {p['symbol']['all_gold_like_symbols_at_broker']}",
                  f"- Tick at preflight: bid {p['tick']['bid']} / ask {p['tick']['ask']} / spread {p['tick']['spread_points']} pts "
                  f"@ server {p['tick']['server_time']}", "", "| broker spec (from MT5) | value |", "|---|---|"])
        L.extend(f"| {k} | {v} |" for k, v in p["broker_spec_raw"].items() if k != "path")
        x = p["position_size_example"]
        L.append(f"\nPosition size with these values ({x['inputs']}): loss/lot {x['loss_per_lot']}, volume "
                 f"**{x['volume']}** lots, actual risk {x['actual_risk_money']:.2f}. Spec consistency: {p['spec_consistency']}.")

    def b_tz(t):
        nonlocal L
        lm = t["live_measurement"]
        L.extend([f"- Live: **{lm.get('measured_gmt', 'n/a')}** measured from {lm['tick_changes']} tick changes "
                  f"(residual median {lm.get('residual_median_s')}s, range {lm.get('residual_min_s')}..{lm.get('residual_max_s')}s); "
                  f"PC clock vs NTP {lm.get('pc_clock_minus_ntp_s')}s",
                  f"- Configured rule `{lm['rule']}` gives GMT{lm['rule_offset_now_s'] / 3600:+g} now → "
                  f"{'MATCH' if lm['matches_rule'] else 'MISMATCH'}"
                  + (f"; rules matching measurement: {lm.get('rules_matching_measurement')}" if not lm['matches_rule'] else ""),
                  f"- History ({t['history_weekly_open']['weekly_opens_found']} weekly opens, "
                  f"{t['history_weekly_open']['first']} → {t['history_weekly_open']['last']}); assumption: "
                  f"{t['history_weekly_open']['assumption']}", "",
                  "| rule | modal NY weekly open | consistency |", "|---|---|---|"])
        L.extend(f"| `{r}` | {v['modal_ny_open']} | {v['consistency']} |" for r, v in t["history_weekly_open"]["per_rule"].items())
        L += ["", f"**Verdict: {t['verdict']}** {'; '.join(t['reasons'])}", "", "| boundary | server time | UTC | definition |",
              "|---|---|---|---|"]
        for k, v in t["session_boundaries_last_completed"].items():
            if k == "previous_trading_day_D1":
                L.append(f"| Previous trading day (D1 {v['server_date']}) | 00:00 → 24:00 | {v['utc']} | starts {v['new_york']} · H {v['high']} L {v['low']} |")
            else:
                L.append(f"| {k} | {v['server_time']} | {v['utc']} | {v['local']} |")

    def b_ohlc(o):
        nonlocal L
        L.append(f"Compared: {o['app_source']} vs raw `copy_rates_from_pos`. Closed bars must match exactly.\n")
        for tf, v in o["timeframes"].items():
            L.append(f"**{tf}: {'VERIFIED' if v['verified'] else 'MISMATCH'}**\n")
            L += ["| server time | MT5 O/H/L/C | app O/H/L/C | match |", "|---|---|---|---|"]
            L.extend(f"| {r['server_time']} | {r['mt5']} | {r['app']} | {r['match']} |" for r in v["rows"])
            L.append("")

    def b_lv(lv):
        nonlocal L
        L += [f"Evaluated at server {lv['evaluated_at_server']} (UTC {lv['evaluated_at_utc']}), tick size {lv['tick_size']}.", "",
              "| level | independent (raw MT5) | engine | diff (ticks) | result | MT5 chart (manual) | method |",
              "|---|---|---|---|---|---|---|"]
        L.extend(f"| {r['level']} | {r['expected_independent']} | {r['engine']} | {r['diff_ticks']} | "
                 f"{'PASS' if r['pass'] else 'FAIL'} | ____ | {r['method']} |" for r in lv["levels"])
        L += ["", f"Swing liquidity (engine vs independent fractal on raw rows): **{'AGREE' if lv['swings_agree'] else 'DIFFER'}**", "",
              "| TF | side | server time | price | engine | independent | MT5 chart (manual) |", "|---|---|---|---|---|---|---|"]
        L.extend(f"| {s['tf']} | {s['side']} | {s['server_time']} | {s['price']} | {s['engine']} | {s['independent']} | ____ |"
                 for s in lv["swings_last_12_per_tf"])

    def b_sm(sm):
        nonlocal L
        L += [f"Window {sm['window_utc']}, default rules, **{sm['setups_total']} setups**. Paths seen: {sm['paths_seen']}", "",
              "| path | count | example (server time) |", "|---|---|---|"]
        for k, v in sm["paths"].items():
            ex = v["examples"][0]
            L.append(f"| {k} | {v['count']} | {ex['direction']} {ex['liquidity']} swept {ex['sweep_server_time']}"
                     f"{' · MSS ' + ex['mss_server_time'] if ex['mss_server_time'] else ''}"
                     f"{' · entry ' + ex['entry_server_time'] if ex['entry_server_time'] else ''} |")

    def b_live(lv):
        nonlocal L
        c = lv["exactly_once"]
        L += [f"- Window {lv['window_utc']}: {lv['ticks_received_by_dashboard']} ticks reached the dashboard, "
              f"{lv['bid_changes']} bid changes, latency median {lv['tick_to_dashboard_latency_s']['median']}s",
              f"- Current-candle updates pushed: {lv['current_candle_updates']}; M5 closes observed {lv['m5_closes_observed']}",
              f"- Closed M5 bars processed: {c['processed_in_window']} · duplicates {c['duplicates']} · missing vs MT5 "
              f"{c['missing_vs_mt5']} · in order {c['in_order']} · look-ahead violations {c['lookahead_violations']} · "
              f"processing delay after close {c['processing_delay_s']} s",
              f"- **Result: {'VERIFIED' if lv['verified'] else 'NOT PROVEN'}**"]

    def b_dc(d):
        nonlocal L
        L += [f"- Outage {d['outage_utc']}; states seen {d['states_seen']}",
              f"- Bars processed while not live: {d['bars_processed_while_not_live']} · signals created while not live: "
              f"{d['signals_created_while_not_live']}",
              f"- M5 closes during outage {d['m5_closes_during_outage']} → caught up after reconnect "
              f"{d['caught_up_after_reconnect']} · not caught up {d['not_caught_up']}",
              f"- **STALE protection: {d['verified_stale_protection']} · reconnect catch-up: {d['verified_reconnect_catch_up']}**",
              "", "| time (UTC) | status | detail |", "|---|---|---|"]
        L.extend(f"| {s['at']} | {s['status']} | {s['detail'] or ''} |" for s in d["timeline"])

    def b_bl(b):
        nonlocal L
        L.append(baseline_markdown(b).split("\n", 1)[1])

    section("1. MT5 connection, symbol and broker specification", "preflight", b_pre)
    section("2. Broker server time", "timezone", b_tz)
    section("3. OHLC: dashboard vs MT5", "ohlc", b_ohlc)
    section("4. Liquidity levels", "levels", b_lv)
    section("5. State machine on real data (progressions and rejections)", "statemachine", b_sm)
    section("6. Live updates and exactly-once candle processing", "live", b_live)
    section("7. Stale / disconnect / reconnect", "disconnect", b_dc)
    section("8. BASELINE backtest (frozen, default rules)", "baseline", b_bl)
    L += ["## 9. Automated tests", ""]
    t = e.get("tests")
    L.append(f"`{t['summary']}` on {t['platform']} (commit `{t['git_commit']}`), real-history replay: "
             f"{t['real_mt5_history_replay_test']}" if t else "**PENDING** – run `python -m xau.validate tests`.")
    L += ["", "These tests use **TEST/SYNTHETIC DATA** (hand-built candles, MT5 test double). They prove rule logic, "
          "no look-ahead, live/backtest parity and stale handling in code; they are not market evidence.", "",
          "## 10. Screenshots", "",
          "Save real screenshots (Win+Shift+S) to `docs/validation/screenshots/` with the time in the file name:",
          "`live-dashboard.png`, `mt5-vs-dashboard-M5.png`, `stale.png`, `offline.png`, `reconnected.png`, `levels-chart.png`.", ""]
    shots = sorted((EVIDENCE / "screenshots").glob("*.png")) if (EVIDENCE / "screenshots").exists() else []
    L.extend(f"![{p.stem}](validation/screenshots/{p.name})" for p in shots)
    if not shots:
        L.append("**PENDING** – no screenshots yet.")
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text("\n".join(L) + "\n", encoding="utf-8")
    print(f"  -> {rel(REPORT)}: {done}/{len(GATE)} gate items proven")
    return "\n".join(L)


PHASES = {"preflight": phase_preflight, "timezone": phase_timezone, "ohlc": phase_ohlc, "levels": phase_levels,
          "statemachine": phase_statemachine, "live": phase_live, "disconnect": phase_disconnect,
          "baseline": phase_baseline, "tests": phase_tests, "report": phase_report}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Real-MT5 validation evidence collector")
    ap.add_argument("phase", choices=list(PHASES) + ["auto"],
                    help="'auto' = preflight, timezone, ohlc, levels, statemachine, tests, report")
    ap.add_argument("--minutes", type=float, default=12.0, help="live: watch duration")
    ap.add_argument("--seconds", type=float, default=90.0, help="timezone: live tick sampling")
    ap.add_argument("--days", type=int, default=30, help="statemachine: days of real history")
    ap.add_argument("--years", type=float, default=5.0, help="baseline: max history to request")
    a = ap.parse_args(argv)
    cfg = load_config()
    order = ["preflight", "timezone", "ohlc", "levels", "statemachine", "tests", "report"] if a.phase == "auto" else [a.phase]
    for ph in order:
        print(f"\n== {ph} ==")
        kw = {"live": {"minutes": a.minutes}, "timezone": {"seconds": a.seconds},
              "statemachine": {"days": a.days}, "baseline": {"years": a.years}}.get(ph, {})
        try:
            PHASES[ph](cfg, **kw)
        except SystemExit as e:
            print(e)
            if a.phase != "auto":
                return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
