"""Proofs that no detector / the engine uses future candles.

1. Snapshots never contain a candle whose close time is after the snapshot time
   (for every timeframe), and never contain the forming bar.
2. Truncation invariance: running the engine on the full history and on a store
   that physically only contains data up to time T gives identical state at T.
   If anything looked ahead, the truncated run would differ.
3. Future perturbation: arbitrarily changing every candle after T leaves every
   decision made up to T unchanged.
"""
import json
import random

import pytest

from xau.config import StrategyConfig
from xau.models import Candle, TF_SECONDS
from xau.sessions import SessionEngine
from xau.strategy.engine import StrategyEngine
from xau.strategy.market import MarketStore
from tests.helpers import make_store, path, ts
from tests.scenarios import mirror, sell_scenario, sell_stopped


def dataset():
    """Three scenario days back to back + a mirrored copy: several setups."""
    base = sell_scenario()
    stop = sell_stopped()
    shift = 7 * 86400
    week2 = [Candle(c.time + shift, *c[1:]) for c in mirror(base)]
    week3 = [Candle(c.time + 2 * shift, *c[1:]) for c in stop]
    return base + week2 + week3


def truncate(store: MarketStore, t: int) -> MarketStore:
    """A store that only *has* data available at time t (closed bars + nothing after)."""
    bars = {tf: [c for c in cs if c.time + TF_SECONDS[tf] <= t] for tf, cs in store.bars.items()}
    return MarketStore(bars=bars, spec=store.spec)


def run_states(store, closes):
    eng = StrategyEngine(StrategyConfig(), SessionEngine())
    states = {}
    for ct in closes:
        ev = eng.on_bar(store.snapshot_at(ct))
        states[ct] = json.dumps({"ev": ev, "desc": eng.describe()}, sort_keys=True, default=str)
    return eng, states


def test_snapshot_contains_only_closed_candles():
    store = make_store(dataset())
    for ct in store.m5_close_times()[::37]:
        for t in (ct, ct + 1, ct + 299):
            snap = store.snapshot_at(t)
            for tf, cs in snap.bars.items():
                assert all(c.time + TF_SECONDS[tf] <= t for c in cs), tf
                # and it is the newest closed candle (nothing closed is hidden either)
                full = [c for c in store.bars[tf] if c.time + TF_SECONDS[tf] <= t]
                if full:
                    assert cs[-1] == full[-1]


def test_truncation_invariance():
    store = make_store(dataset())
    closes = store.m5_close_times()
    _, full_states = run_states(store, closes)
    rnd = random.Random(7)
    cuts = sorted(rnd.sample(closes[100:], 12)) + [ts("2025-01-15 08:10"), ts("2025-01-15 09:05")]
    for cut in cuts:
        tr = truncate(store, cut)
        _, tr_states = run_states(tr, [c for c in closes if c <= cut])
        assert tr_states[cut] == full_states[cut], f"state at {cut} depends on future data"


def test_future_perturbation_does_not_change_past_decisions():
    store = make_store(dataset())
    closes = store.m5_close_times()
    _, base = run_states(store, closes)
    T = ts("2025-01-15 09:05")                       # right at the entry candle close
    rnd = random.Random(11)
    m5 = []
    for c in store.bars["M5"]:
        if c.time + 300 > T:
            d = rnd.uniform(-30, 30)
            c = Candle(c.time, c.open + d, c.high + d + rnd.uniform(0, 9), c.low + d - rnd.uniform(0, 9), c.close + d, 1, 20)
        m5.append(c)
    pert = make_store(m5)
    _, other = run_states(pert, closes)
    for ct in closes:
        if ct <= T:
            assert other[ct] == base[ct]
    assert any(other[ct] != base[ct] for ct in closes if ct > T)   # sanity: the perturbation mattered


def test_every_logged_time_is_not_after_decision_time():
    store = make_store(dataset())
    eng = StrategyEngine(StrategyConfig(), SessionEngine())
    for ct in store.m5_close_times():
        for ev in eng.on_bar(store.snapshot_at(ct)):
            bar_open = ct - 300
            for t in (ev["sweep"]["extreme_time"], ev["sweep"]["reclaim_time"],
                      (ev.get("mss") or {}).get("break_time"), (ev.get("fvg") or {}).get("c3_time"),
                      ev.get("entry_time")):
                if t is not None:
                    assert t <= bar_open
            for lvl in [ev["sweep"]["level"]]:
                assert lvl["formed_at"] <= ct
