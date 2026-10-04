"""Fractal swing points.

A swing high at index ``i`` with strength ``k`` requires
``high[i] > high[j]`` for the k bars to the left and ``high[i] >= high[j]``
for the k bars to the right.  Because it needs k bars to the right, a swing
is only *confirmed* once bar ``i+k`` has closed.  Since detectors only ever
see closed candles, every swing returned here was knowable at that time;
``confirmed_at`` records exactly when.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from ..models import Candle, TF_SECONDS


@dataclass(frozen=True)
class Swing:
    index: int          # index in the list that was analysed
    time: int           # open time of the swing candle (UTC)
    price: float
    kind: str           # "high" | "low"
    confirmed_at: int   # UTC close time of bar i+k


def find_swings(bars: Sequence[Candle], k: int, tf: str) -> tuple[list[Swing], list[Swing]]:
    highs: list[Swing] = []
    lows: list[Swing] = []
    n = len(bars)
    step = TF_SECONDS[tf]
    hs = [b.high for b in bars]
    ls = [b.low for b in bars]
    for i in range(k, n - k):
        h, l = hs[i], ls[i]
        if h > max(hs[i - k:i]) and h >= max(hs[i + 1:i + k + 1]):
            highs.append(Swing(i, bars[i].time, h, "high", bars[i + k].time + step))
        if l < min(ls[i - k:i]) and l <= min(ls[i + 1:i + k + 1]):
            lows.append(Swing(i, bars[i].time, l, "low", bars[i + k].time + step))
    return highs, lows


def structure_bias(bars: Sequence[Candle], k: int, tf: str) -> str:
    """Deterministic market-structure bias from the last two confirmed swings.

    bullish  : higher high AND higher low
    bearish  : lower high AND lower low
    otherwise: neutral
    A close beyond the latest swing in the opposite direction overrides to
    neutral (structure is in transition).
    """
    highs, lows = find_swings(bars, k, tf)
    if len(highs) < 2 or len(lows) < 2 or not bars:
        return "neutral"
    h1, h2 = highs[-2].price, highs[-1].price
    l1, l2 = lows[-2].price, lows[-1].price
    last_close = bars[-1].close
    if h2 > h1 and l2 > l1:
        return "neutral" if last_close < l2 else "bullish"
    if h2 < h1 and l2 < l1:
        return "neutral" if last_close > h2 else "bearish"
    return "neutral"
