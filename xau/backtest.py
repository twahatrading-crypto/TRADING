"""Historical backtest using the SAME strategy engine as live mode.

    market data (MT5 history or stored CSV)
        -> normalized candles (MarketStore, UTC)
        -> snapshot_at(close of each M5 bar)   [closed candles only]
        -> StrategyEngine.on_bar                [identical to live]
        -> setups / trades -> statistics

Usage (Windows, MT5 terminal running):
    python -m xau.backtest --from 2024-01-01 --to 2024-12-31
    python -m xau.backtest --source csv --csv-dir data/history --from 2024-01-01 --to 2024-06-30

Statistics are reported in R (multiples of the initial structural risk).
A positive result here does NOT by itself make the strategy suitable for
live trading – check sample size, drawdown, and out-of-sample periods.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

from .config import ROOT, StrategyConfig, load_config
from .models import Candle, SymbolSpec, TF_SECONDS
from .sessions import SessionDef, SessionEngine
from .strategy.engine import StrategyEngine
from .strategy.market import MarketStore
from .timeutil import ServerClock, iso_utc, parse_iso_utc

BT_TIMEFRAMES = ["M5", "M15", "H1", "H4", "D1"]
EXIT_KEYS = ["TP1", "TP2", "2R", "3R", "4R"]


# ------------------------------------------------------------------ storage
def save_csv(path: Path, candles: list[Candle]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["time_utc", "open", "high", "low", "close", "tick_volume", "spread", "real_volume"])
        for c in candles:
            w.writerow([c.time, c.open, c.high, c.low, c.close, c.tick_volume, c.spread, c.real_volume])


def load_csv(path: Path) -> list[Candle]:
    out = []
    with open(path, newline="") as fh:
        for r in csv.DictReader(fh):
            out.append(Candle(int(r["time_utc"]), float(r["open"]), float(r["high"]), float(r["low"]),
                              float(r["close"]), int(float(r.get("tick_volume") or 0)),
                              int(float(r.get("spread") or 0)), int(float(r.get("real_volume") or 0))))
    return out


def save_spec(path: Path, spec: SymbolSpec) -> None:
    path.write_text(json.dumps(spec.to_dict(), indent=2))


def load_spec(path: Path) -> Optional[SymbolSpec]:
    return SymbolSpec(**json.loads(path.read_text())) if path.exists() else None


def load_store_from_csv(csv_dir: Path, symbol: str) -> MarketStore:
    bars = {}
    for tf in BT_TIMEFRAMES:
        p = csv_dir / f"{symbol}_{tf}.csv"
        if not p.exists():
            raise FileNotFoundError(f"missing {p} – export history first (python -m xau.backtest --export ...)")
        bars[tf] = load_csv(p)
    return MarketStore(bars=bars, spec=load_spec(csv_dir / f"{symbol}_spec.json"))


def fetch_store_from_mt5(cfg, utc_from: int, utc_to: int, csv_dir: Optional[Path]) -> MarketStore:
    from .mt5_client import MT5Client, load_mt5_module
    mod = load_mt5_module()
    client = MT5Client(mod, ServerClock(cfg.feed.server_timezone), cfg.feed.terminal_path)
    if not client.connect():
        raise SystemExit(client.last_error)
    try:
        symbol = cfg.feed.symbol_override or client.detect_symbol(cfg.feed.symbol_candidates)[0]
        if not symbol:
            raise SystemExit("could not detect an XAUUSD symbol – set feed.symbol_override")
        client.select(symbol)
        spec = client.spec(symbol)
        warm = 15 * 86400
        bars = {}
        for tf in BT_TIMEFRAMES:
            bars[tf] = client.rates_range(symbol, tf, utc_from - warm, utc_to)
            print(f"  {symbol} {tf}: {len(bars[tf])} candles", file=sys.stderr)
            if csv_dir:
                save_csv(csv_dir / f"{symbol}_{tf}.csv", bars[tf])
        if csv_dir and spec:
            save_spec(csv_dir / f"{symbol}_spec.json", spec)
        return MarketStore(bars=bars, spec=spec)
    finally:
        client.shutdown()


# ------------------------------------------------------------------- engine
def make_sessions(cfg) -> SessionEngine:
    return SessionEngine([SessionDef(**s) for s in cfg.sessions])


def run_backtest(store: MarketStore, strategy: StrategyConfig, sessions: SessionEngine,
                 utc_from: Optional[int] = None, utc_to: Optional[int] = None,
                 progress: bool = False, on_event=None) -> tuple[StrategyEngine, list[dict]]:
    symbol = store.spec.name if store.spec else "XAUUSD"
    eng = StrategyEngine(strategy, sessions, symbol=symbol)
    setups: dict[str, dict] = {}
    closes = store.m5_close_times(utc_from, utc_to)
    t0 = time.time()
    for n, ct in enumerate(closes):
        for ev in eng.on_bar(store.snapshot_at(ct)):
            setups[ev["id"]] = ev
            if on_event:
                on_event(ev)
        if progress and n % 2000 == 0 and n:
            el = time.time() - t0
            print(f"  {iso_utc(ct)}  {n}/{len(closes)} bars  {el:.0f}s", file=sys.stderr)
    return eng, list(setups.values())


# -------------------------------------------------------------------- stats
def _summary(rs: list[float]) -> dict:
    n = len(rs)
    if n == 0:
        return {"trades": 0}
    wins = [r for r in rs if r > 0]
    losses = [r for r in rs if r <= 0]
    gross_win, gross_loss = sum(wins), -sum(losses)
    eq = peak = dd = 0.0
    streak = max_streak = 0
    for r in rs:
        eq += r
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
        streak = streak + 1 if r <= 0 else 0
        max_streak = max(max_streak, streak)
    avg_win = gross_win / len(wins) if wins else 0.0
    avg_loss = gross_loss / len(losses) if losses else 0.0
    wr = len(wins) / n
    return {
        "trades": n, "wins": len(wins), "losses": len(losses), "win_rate": round(wr, 4),
        "avg_r": round(sum(rs) / n, 4), "total_r": round(sum(rs), 3),
        "avg_win_r": round(avg_win, 3), "avg_loss_r": round(avg_loss, 3),
        "expectancy_r": round(wr * avg_win - (1 - wr) * avg_loss, 4),
        "profit_factor": round(gross_win / gross_loss, 3) if gross_loss > 0 else None,
        "max_drawdown_r": round(dd, 3), "max_consecutive_losses": max_streak,
    }


def compute_stats(setups: list[dict], include_untaken: bool = False) -> dict:
    closed = [s for s in setups if s.get("trade") and s["trade"].get("result") in ("WIN", "LOSS", "TIMEOUT")]
    trades = sorted([s for s in closed if include_untaken or s.get("taken")], key=lambda s: s["entry_time"])
    rs = [s["trade"]["r_result"] for s in trades]
    out = {"population": "all filled setups" if include_untaken else "A+ signals only",
           "overall": _summary(rs)}
    out["overall"]["timeouts"] = sum(1 for s in trades if s["trade"]["result"] == "TIMEOUT")

    def group(keyf):
        g = defaultdict(list)
        for s in trades:
            g[keyf(s)].append(s["trade"]["r_result"])
        return {k: _summary(v) for k, v in sorted(g.items())}

    # inclusive: a London/New York overlap trade counts in both sessions
    sess = defaultdict(list)
    for s in trades:
        names = [x for x in (s.get("session") or "").split("/") if x and x != "Off-session"] or ["Off-session"]
        for n in names:
            sess[n].append(s["trade"]["r_result"])
    out["by_session"] = {k: _summary(sess.get(k, [])) for k in ("Asian", "London", "New York", "Off-session")}
    out["by_session_label"] = group(lambda s: s.get("session") or "?")
    out["by_direction"] = group(lambda s: s["direction"])
    out["by_year"] = group(lambda s: datetime.fromtimestamp(s["entry_time"], timezone.utc).strftime("%Y"))
    out["by_month"] = group(lambda s: datetime.fromtimestamp(s["entry_time"], timezone.utc).strftime("%Y-%m"))
    out["by_liquidity"] = group(lambda s: s["sweep"]["level"]["kind"])
    exits = {}
    for k in EXIT_KEYS:
        vals = [s["trade"]["outcomes"][k]["r"] for s in trades
                if s["trade"]["outcomes"].get(k, {}).get("r") is not None]
        exits[k] = _summary(vals)
    out["exits"] = exits

    funnel = defaultdict(int)
    for s in setups:
        if s.get("grade"):
            funnel[f"entered:{s['grade']}"] += 1
        elif s.get("status") in ("NO_TRADE", "INVALIDATED", "EXPIRED"):
            funnel[f"{s['status']}@{s.get('failed_stage') or '?'}"] += 1
        else:
            funnel[f"open:{s.get('stage')}"] += 1
    out["funnel"] = dict(sorted(funnel.items()))
    out["setups_total"] = len(setups)
    return out


def format_report(stats: dict) -> str:
    L = []
    o = stats["overall"]
    L.append(f"=== Backtest ({stats['population']}) ===")
    if not o.get("trades"):
        L.append("No completed trades in this period.")
    else:
        L.append(f"Trades {o['trades']}  Wins {o['wins']}  Losses {o['losses']}  Timeouts {o.get('timeouts', 0)}")
        L.append(f"Win rate {o['win_rate']*100:.1f}%  Avg R {o['avg_r']:+.3f}  Expectancy {o['expectancy_r']:+.3f}R  "
                 f"PF {o['profit_factor']}  Total {o['total_r']:+.2f}R")
        L.append(f"Max drawdown {o['max_drawdown_r']:.2f}R  Max consecutive losses {o['max_consecutive_losses']}")
    for title, key in (("Session", "by_session"), ("Direction", "by_direction"), ("Year", "by_year"),
                       ("Month", "by_month"), ("Liquidity", "by_liquidity"), ("Exit", "exits")):
        L.append(f"\n-- by {title} --")
        for k, v in stats[key].items():
            if not v.get("trades"):
                L.append(f"  {k:<14} 0 trades")
                continue
            L.append(f"  {k:<14} n={v['trades']:<4} win {v['win_rate']*100:5.1f}%  avgR {v['avg_r']:+.3f}  "
                     f"PF {v['profit_factor']}  DD {v['max_drawdown_r']:.2f}R  total {v['total_r']:+.2f}R")
    L.append("\n-- setup funnel (why setups did / did not become trades) --")
    for k, v in stats["funnel"].items():
        L.append(f"  {k:<40} {v}")
    L.append("\nNOTE: results describe past data only; they are not evidence of future profitability.")
    return "\n".join(L)


def main(argv: Optional[Iterable[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="XAUUSD liquidity-sweep strategy backtest (same engine as live)")
    ap.add_argument("--from", dest="date_from", required=True, help="YYYY-MM-DD (UTC)")
    ap.add_argument("--to", dest="date_to", required=True, help="YYYY-MM-DD (UTC)")
    ap.add_argument("--source", choices=["mt5", "csv"], default="mt5")
    ap.add_argument("--csv-dir", default=str(ROOT / "data" / "history"))
    ap.add_argument("--symbol", default="", help="symbol name for --source csv")
    ap.add_argument("--include-untaken", action="store_true",
                    help="also count filled setups that failed filters/score (for filter research)")
    ap.add_argument("--entry-mode", choices=["limit_ce", "limit_edge", "confirmation"])
    ap.add_argument("--out", default=str(ROOT / "data" / "backtests"))
    args = ap.parse_args(list(argv) if argv is not None else None)

    cfg = load_config()
    if args.entry_mode:
        cfg.strategy.entry.mode = args.entry_mode
    utc_from = parse_iso_utc(args.date_from + "T00:00:00Z")
    utc_to = parse_iso_utc(args.date_to + "T23:59:59Z")
    csv_dir = Path(args.csv_dir)
    if args.source == "mt5":
        print("Fetching history from MT5 ...", file=sys.stderr)
        store = fetch_store_from_mt5(cfg, utc_from, utc_to, csv_dir)
    else:
        sym = args.symbol or cfg.feed.symbol_override or "XAUUSD"
        store = load_store_from_csv(csv_dir, sym)
    if not store.bars.get("M5"):
        raise SystemExit("no M5 history available for that range")
    first = store.bars["M5"][0].time
    if first > utc_from - 3 * 86400:
        print(f"warning: M5 history starts {iso_utc(first)}; early signals may lack warm-up "
              f"(increase 'Max bars in chart' in MT5 Options > Charts)", file=sys.stderr)

    print("Running strategy engine ...", file=sys.stderr)
    _, setups = run_backtest(store, cfg.strategy, make_sessions(cfg), utc_from, utc_to, progress=True)
    stats = compute_stats(setups, include_untaken=args.include_untaken)
    report = format_report(stats)
    print(report)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    (out / f"bt-{stamp}.json").write_text(json.dumps({"args": vars(args), "config": cfg.to_dict()["strategy"], "stats": stats,
                                                      "setups": setups}, indent=1, default=str))
    (out / f"bt-{stamp}.txt").write_text(report)
    print(f"\nSaved {out / f'bt-{stamp}.json'}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
