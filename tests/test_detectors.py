import pytest

from xau.config import DisplacementConfig, FVGConfig, LiquidityConfig, MSSConfig, SweepConfig
from xau.models import Candle
from xau.sessions import SessionEngine
from xau.strategy.displacement import find_displacement
from xau.strategy.fvg import find_fvgs, select_fvg, touched_since
from xau.strategy.indicators import atr, close_location, median_body
from xau.strategy.liquidity import Level, compute_levels
from xau.strategy.structure import check_mss, protected_swing
from xau.strategy.sweep import detect_sweeps, pick_sweep
from xau.strategy.swings import find_swings, structure_bias
from tests.helpers import bar, make_store, path, ts
from tests.scenarios import sell_core, sell_scenario

T0 = ts("2025-01-15 00:00")


def flat(n, price=100.0, t0=T0, rng=1.0):
    return [bar(t0 + i * 300, price, price + rng / 2, price - rng / 2, price + (0.1 if i % 2 else -0.1)) for i in range(n)]


# ------------------------------------------------------------------ swings
def test_swing_requires_k_confirmed_right_bars():
    hs = [1, 2, 3, 9, 3, 2, 1]
    bars = [bar(T0 + i * 300, h - 0.5, h, h - 1, h - 0.5) for i, h in enumerate(hs)]
    highs, _ = find_swings(bars, 2, "M5")
    assert [s.index for s in highs] == [3]
    assert highs[0].confirmed_at == bars[5].time + 300          # close of bar i+k
    # with only one right bar closed the swing is NOT yet known
    highs2, _ = find_swings(bars[:5], 2, "M5")
    assert highs2 == []


def test_structure_bias():
    up = path(T0, 100, [(6, 104), (4, 102), (6, 107), (4, 105), (6, 110), (4, 108), (3, 109)], wick=0.1)
    assert structure_bias(up, 2, "M5") == "bullish"
    dn = path(T0, 110, [(6, 106), (4, 108), (6, 103), (4, 105), (6, 100), (4, 102), (3, 101)], wick=0.1)
    assert structure_bias(dn, 2, "M5") == "bearish"


def test_indicators():
    bars = flat(30)
    assert atr(bars, 14) == pytest.approx(1.0, abs=0.25)
    assert median_body(bars, 20) == pytest.approx(0.1, abs=0.15)
    assert close_location(bar(T0, 10, 11, 9, 9)) == 0.0
    assert close_location(bar(T0, 10, 11, 9, 11)) == 1.0


# ---------------------------------------------------------------- liquidity
def test_liquidity_levels_from_scenario():
    store = make_store(sell_core())
    snap = store.snapshot_at(ts("2025-01-15 08:00"))          # before the sweep candle closes
    levels = compute_levels(snap, LiquidityConfig(), SessionEngine(), atr(snap.m5(), 14))
    by = {l.kind: l for l in levels}
    assert by["PDH"].price == pytest.approx(2675.6)
    assert by["PDL"].price == pytest.approx(2631.4)
    assert by["ASIA_HIGH"].price == pytest.approx(2655.6)
    assert by["ASIA_LOW"].price == pytest.approx(2648.4)
    # equal highs at the Asia high are merged as confluence, not double counted
    assert "EQH" in by["ASIA_HIGH"].tags
    assert all(l.formed_at <= snap.now for l in levels)
    assert by["ASIA_HIGH"].formed_at == ts("2025-01-15 06:00")    # only known once the session ended
    # non-live levels are only kept while a sweep of them could still be confirmed
    n = len(snap.m5())
    assert all(l.is_live() or n - 1 - l.m5_take_index < SweepConfig().reclaim_max_bars for l in levels)


def test_asia_range_not_used_while_session_open():
    store = make_store(sell_core())
    snap = store.snapshot_at(ts("2025-01-15 03:00"))
    levels = compute_levels(snap, LiquidityConfig(), SessionEngine(), atr(snap.m5(), 14))
    asia = [l for l in levels if l.kind.startswith("ASIA")]
    # the levels seen at 03:00 belong to the previous (completed) Asian session, never today's partial one
    assert all(l.formed_at == ts("2025-01-14 06:00") for l in asia)


def test_taken_level_is_not_liquidity_anymore():
    store = make_store(sell_scenario())
    snap = store.snapshot_at(ts("2025-01-15 10:00"))
    levels = compute_levels(snap, LiquidityConfig(), SessionEngine(), atr(snap.m5(), 14))
    assert not any(l.kind == "ASIA_HIGH" for l in levels)          # swept at 08:00
    assert not any(l.kind == "ASIA_LOW" for l in levels)           # traded through on the way down


# -------------------------------------------------------------------- sweep
def _lvl(price, side, take_index):
    l = Level("ASIA_HIGH" if side == "high" else "ASIA_LOW", side, price, T0, T0)
    l.m5_take_index = take_index
    l.taken_time = T0 + take_index * 300
    return l


def test_sweep_same_candle_reclaim_sell():
    m5 = flat(40)
    m5.append(bar(m5[-1].time + 300, 100, 101.2, 99.8, 100.1))     # wick above 100.8, close below
    sw = detect_sweeps(m5, [_lvl(100.8, "high", 40)], 1.0, SweepConfig(), 0.01)
    assert len(sw) == 1 and sw[0].direction == "SELL" and sw[0].reclaim_bars == 1
    assert sw[0].extreme_price == 101.2 and sw[0].penetration == pytest.approx(0.4)


def test_sweep_needs_reclaim_close():
    m5 = flat(40)
    m5.append(bar(m5[-1].time + 300, 100, 101.2, 99.8, 101.0))     # closes ABOVE the level
    assert detect_sweeps(m5, [_lvl(100.8, "high", 40)], 1.0, SweepConfig(), 0.01) == []


def test_sweep_multi_bar_reclaim_and_window():
    m5 = flat(40)
    m5.append(bar(m5[-1].time + 300, 100, 101.2, 99.9, 101.0))     # take, close above
    m5.append(bar(m5[-1].time + 300, 101.0, 101.3, 100.2, 100.3))  # reclaim on bar 2
    sw = detect_sweeps(m5, [_lvl(100.8, "high", 40)], 1.0, SweepConfig(), 0.01)
    assert sw and sw[0].reclaim_bars == 2 and sw[0].extreme_price == 101.3
    # beyond reclaim_max_bars it is acceptance/breakout, not a sweep
    assert detect_sweeps(m5, [_lvl(100.8, "high", 40)], 1.0, SweepConfig(reclaim_max_bars=1), 0.01) == []


def test_sweep_rejects_breakout_depth_and_tiny_poke():
    m5 = flat(40)
    m5.append(bar(m5[-1].time + 300, 100, 103.0, 99.8, 100.1))     # 2.2 x ATR beyond: breakout
    assert detect_sweeps(m5, [_lvl(100.8, "high", 40)], 1.0, SweepConfig(), 0.01) == []
    m5[-1] = bar(m5[-1].time, 100, 100.82, 99.8, 100.1)            # 0.02 poke < minimum
    assert detect_sweeps(m5, [_lvl(100.8, "high", 40)], 1.0, SweepConfig(), 0.01) == []


def test_sweep_buy_side_mirror():
    m5 = flat(40)
    m5.append(bar(m5[-1].time + 300, 100, 100.2, 98.9, 99.9))
    sw = detect_sweeps(m5, [_lvl(99.3, "low", 40)], 1.0, SweepConfig(), 0.01)
    assert sw and sw[0].direction == "BUY" and sw[0].extreme_price == 98.9


def test_pick_sweep_ambiguous_outside_bar():
    m5 = flat(40)
    m5.append(bar(m5[-1].time + 300, 100, 101.2, 98.8, 100.0))
    sws = detect_sweeps(m5, [_lvl(100.8, "high", 40), _lvl(99.2, "low", 40)], 1.0, SweepConfig(), 0.01)
    assert len(sws) == 2 and pick_sweep(sws) is None


# ---------------------------------------------------------------------- MSS
def test_protected_swing_and_mss_after_sweep():
    m5 = sell_core()
    times = [c.time for c in m5]
    ext_i = times.index(ts("2025-01-15 08:00"))
    sw = protected_swing(m5[:ext_i + 1], ext_i, "SELL", MSSConfig())
    assert sw is not None and sw.price == pytest.approx(2652.0) and sw.index < ext_i
    # the sweep candle itself does not break structure
    assert check_mss(m5[ext_i], sw, "SELL", 0, 1.5) is None
    m = check_mss(m5[ext_i + 1], sw, "SELL", 1, 1.5)
    assert m is not None and m.level == pytest.approx(2652.0) and m.break_close == 2650.8


def test_mss_requires_close_not_wick():
    sw_bars = path(T0, 100, [(6, 103), (4, 101), (6, 104)], wick=0.1)
    from xau.strategy.swings import Swing
    s = Swing(9, sw_bars[9].time, 100.9, "low", 0)
    wick_only = bar(T0 + 9999, 101.5, 101.6, 100.5, 101.2)
    assert check_mss(wick_only, s, "SELL", 3, 1.0) is None


# ------------------------------------------------------------- displacement
def test_displacement_single_candle_rules():
    m5 = flat(40)
    big = bar(m5[-1].time + 300, 100.0, 100.1, 97.4, 97.5)          # body 2.5 >> ATR~1, closes on low
    m5.append(big)
    d = find_displacement(m5, 40, 40, "SELL", DisplacementConfig())
    assert d is not None and d.rule == "single" and d.best_body_atr > 2


def test_large_candle_without_close_location_is_not_displacement():
    m5 = flat(40)
    m5.append(bar(m5[-1].time + 300, 100.0, 100.1, 96.0, 98.4))     # long tail: closes mid-range
    assert find_displacement(m5, 40, 40, "SELL", DisplacementConfig()) is None


def test_wrong_direction_and_small_body_rejected():
    m5 = flat(40)
    m5.append(bar(m5[-1].time + 300, 97.5, 100.1, 97.4, 100.0))     # bullish
    assert find_displacement(m5, 40, 40, "SELL", DisplacementConfig()) is None
    m5[-1] = bar(m5[-1].time, 100.0, 100.1, 99.3, 99.4)             # bearish but small
    assert find_displacement(m5, 40, 40, "SELL", DisplacementConfig()) is None


def test_consecutive_displacement():
    m5 = flat(40)
    t = m5[-1].time
    for k in range(4):
        o = 100 - k * 0.7
        m5.append(bar(t + (k + 1) * 300, o, o + 0.05, o - 0.75, o - 0.7))
    cfg = DisplacementConfig(min_body_atr=5)                          # disable the single-candle rule
    d = find_displacement(m5, 40, 44, "SELL", cfg)
    assert d is not None and d.rule == "consecutive" and d.consecutive == 4


# ---------------------------------------------------------------------- FVG
def test_bearish_fvg_detection_and_touch():
    m5 = sell_core()
    n = len(m5)
    f = find_fvgs(m5, n - 3, n - 1, "SELL", FVGConfig(), 1.5, 0.01)
    assert len(f) == 1
    assert (f[0].bottom, f[0].top) == (2651.2, 2654.4) and f[0].mid == pytest.approx(2652.8)
    assert not touched_since(m5, f[0], f[0].mid)
    later = m5 + [bar(m5[-1].time + 300, 2649.4, 2653.0, 2649.0, 2652.5)]
    assert touched_since(later, f[0], f[0].mid)


def test_fvg_needs_closed_third_candle_and_gap():
    m5 = sell_core()
    n = len(m5)
    # without the third candle there is no FVG
    assert find_fvgs(m5[:-1], n - 3, n - 2, "SELL", FVGConfig(), 1.5, 0.01) == []
    # overlapping wicks => no gap
    m5[-1] = bar(m5[-1].time, 2650.8, 2654.6, 2649.0, 2649.4)
    assert find_fvgs(m5, n - 3, n - 1, "SELL", FVGConfig(), 1.5, 0.01) == []


def test_select_fvg_largest():
    m5 = sell_core()
    n = len(m5)
    f = find_fvgs(m5, n - 3, n - 1, "SELL", FVGConfig(), 1.5, 0.01)
    assert select_fvg(f) is f[0] and select_fvg([]) is None


def test_candle_model():
    c = Candle(0, 1, 3, 0.5, 2)
    assert c.body == 1 and c.range == 2.5 and c.bullish and not c.bearish
