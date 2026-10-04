"""Hand-specified candle sequences for rule tests (test fixtures only).

``sell_scenario`` (UTC, Wed 2025-01-15, broker NY+7 = GMT+2 in winter):
  * prior days build PDH ~2675.6 / PDL ~2631.4
  * Asian session 00:00-06:00 UTC ranges 2648.4 - 2655.6 (two equal highs)
  * 07:25-07:30 a swing low ~2652.0 forms (the protected low)
  * 08:00 London: candle runs to 2656.2 above Asia High and closes back below (sweep)
  * 08:05 bearish displacement closes 2650.8 (< 2652.0 => MSS)
  * 08:10 third candle leaves a bearish FVG 2651.2 - 2654.4
  * price retraces into the FVG at ~09:00, then falls to the PDL (TP2)
"""
from __future__ import annotations

from xau.models import Candle
from tests.helpers import bar, path, ts

W = 0.6


def _prefix() -> list[Candle]:
    m5 = path(ts("2025-01-12 22:00"), 2660, [(144, 2668), (144, 2660)], wick=W)
    m5 += path(m5[-1].time + 300, 2660, [(60, 2675), (120, 2632), (108, 2650)], wick=W)
    m5 += path(m5[-1].time + 300, 2650, [(24, 2652), (12, 2655), (18, 2649), (18, 2655), (24, 2650)], wick=W)
    m5 += path(m5[-1].time + 300, 2650, [(12, 2654), (6, 2652.6), (6, 2654.6)], wick=W)
    assert m5[-1].time + 300 == ts("2025-01-15 08:00")
    return m5


def sell_core() -> list[Candle]:
    m5 = _prefix()
    t = ts("2025-01-15 08:00")
    m5.append(bar(t, 2654.6, 2656.2, 2654.4, 2655.0))          # sweep of Asia High (2655.6)
    m5.append(bar(t + 300, 2655.0, 2655.1, 2650.6, 2650.8))    # displacement + MSS
    m5.append(bar(t + 600, 2650.8, 2651.2, 2649.0, 2649.4))    # FVG third candle
    return m5


def sell_scenario() -> list[Candle]:
    m5 = sell_core()
    return m5 + path(m5[-1].time + 300, 2649.4, [(5, 2649.5), (6, 2653.0), (30, 2628), (20, 2630)], wick=W)


def sell_stopped() -> list[Candle]:
    """Retraces into the FVG, then runs through the stop."""
    m5 = sell_core()
    return m5 + path(m5[-1].time + 300, 2649.4, [(5, 2649.5), (6, 2653.0), (10, 2658.5), (10, 2660)], wick=W)


def sell_no_retrace() -> list[Candle]:
    """Never comes back to the FVG: falls straight to the targets (must not chase)."""
    m5 = sell_core()
    return m5 + path(m5[-1].time + 300, 2649.4, [(30, 2628), (10, 2630)], wick=W)


def mirror(m5: list[Candle], axis: float = 2650.0) -> list[Candle]:
    m = 2 * axis
    return [Candle(c.time, round(m - c.open, 2), round(m - c.low, 2), round(m - c.high, 2), round(m - c.close, 2),
                   c.tick_volume, c.spread) for c in m5]
