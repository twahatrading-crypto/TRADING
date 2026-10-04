"""Small deterministic indicator helpers.  Inputs are lists of *closed* candles."""
from __future__ import annotations

from statistics import median
from typing import Optional, Sequence

from ..models import Candle


def atr(bars: Sequence[Candle], period: int = 14, end: Optional[int] = None) -> float:
    """Wilder ATR computed over ``bars[:end]`` (end exclusive, default all)."""
    bs = bars[:end] if end is not None else bars
    # fixed-length tail: Wilder ATR has converged after ~10 periods, and a window
    # anchored to the newest bar keeps the value identical in live and backtest.
    bs = bs[-(period * 10 + 1):]
    if len(bs) < 2:
        return (bs[-1].high - bs[-1].low) if bs else 0.0
    trs = []
    for i in range(1, len(bs)):
        c, p = bs[i], bs[i - 1]
        trs.append(max(c.high - c.low, abs(c.high - p.close), abs(c.low - p.close)))
    if len(trs) <= period:
        return sum(trs) / len(trs)
    a = sum(trs[:period]) / period
    for tr in trs[period:]:
        a = (a * (period - 1) + tr) / period
    return a


def median_body(bars: Sequence[Candle], period: int = 20, end: Optional[int] = None) -> float:
    """Median candle body of the ``period`` candles before ``end`` (exclusive)."""
    end = len(bars) if end is None else end
    window = bars[max(0, end - period):end]
    if not window:
        return 0.0
    return float(median(c.body for c in window))


def close_location(c: Candle) -> float:
    """0 = closed on the low, 1 = closed on the high."""
    rng = c.high - c.low
    return 0.5 if rng <= 0 else (c.close - c.low) / rng
