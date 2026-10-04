"""Liquidity sweep detection.

SELL setup: price trades *above* buy-side liquidity (a "high" level) and then
closes back *below* it within ``reclaim_max_bars`` M5 candles.
BUY setup : price trades *below* sell-side liquidity and closes back above.

Touching or breaking a level is NOT a sweep on its own: the reclaim close is
required, and a penetration larger than ``max_penetration_atr`` is treated as
a breakout (no sweep).
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Optional, Sequence

from ..config import SweepConfig
from ..models import Candle
from .liquidity import Level


@dataclass
class Sweep:
    direction: str            # trade direction implied: "SELL" (buy-side swept) | "BUY"
    level: dict               # Level.to_dict()
    level_price: float
    sweep_time: int           # open time of first candle trading through the level
    extreme_price: float      # furthest price reached beyond the level
    extreme_time: int
    extreme_index: int        # M5 index (in the snapshot the sweep was detected in)
    reclaim_time: int         # open time of the candle that closed back inside
    reclaim_bars: int         # 1 = same-candle reclaim
    penetration: float        # price distance beyond the level
    penetration_atr: float
    rejection_wick_ratio: float  # rejection wick of the extreme candle / its range

    def to_dict(self) -> dict:
        return asdict(self)


def detect_sweeps(m5: Sequence[Candle], levels: list[Level], atr_m5: float,
                  cfg: SweepConfig, point: float) -> list[Sweep]:
    """Sweeps confirmed by the LAST candle of ``m5`` (all candles are closed)."""
    if not m5 or atr_m5 <= 0:
        return []
    i = len(m5) - 1
    cur = m5[i]
    min_pen = max(cfg.min_penetration_points * point, cfg.min_penetration_atr * atr_m5)
    max_pen = cfg.max_penetration_atr * atr_m5
    out: list[Sweep] = []
    for lvl in levels:
        j = lvl.m5_take_index
        if j is None or j > i or i - j >= cfg.reclaim_max_bars:
            continue
        seg = m5[j:i + 1]
        if lvl.side == "high":
            if not cur.close < lvl.price:
                continue
            if any(c.close < lvl.price for c in m5[j:i]):
                continue          # it already reclaimed earlier: handled on that bar
            ext_c = max(seg, key=lambda c: c.high)
            pen = ext_c.high - lvl.price
            wick = ext_c.high - max(ext_c.open, ext_c.close)
            direction = "SELL"
            extreme = ext_c.high
        else:
            if not cur.close > lvl.price:
                continue
            if any(c.close > lvl.price for c in m5[j:i]):
                continue
            ext_c = min(seg, key=lambda c: c.low)
            pen = lvl.price - ext_c.low
            wick = min(ext_c.open, ext_c.close) - ext_c.low
            direction = "BUY"
            extreme = ext_c.low
        if pen < min_pen or pen > max_pen:
            continue
        rng = ext_c.high - ext_c.low
        ext_idx = j + seg.index(ext_c)
        out.append(Sweep(
            direction=direction, level=lvl.to_dict(), level_price=lvl.price,
            sweep_time=m5[j].time, extreme_price=extreme, extreme_time=ext_c.time,
            extreme_index=ext_idx, reclaim_time=cur.time, reclaim_bars=i - j + 1,
            penetration=pen, penetration_atr=pen / atr_m5,
            rejection_wick_ratio=(wick / rng) if rng > 0 else 0.0,
        ))
    out.sort(key=lambda s: (-s.level["score"], -s.penetration_atr))
    return out


def pick_sweep(candidates: list[Sweep]) -> Optional[Sweep]:
    """Choose one sweep deterministically.  If both sides were swept by the same
    bar with equal liquidity quality the bar is ambiguous -> no setup."""
    if not candidates:
        return None
    best = candidates[0]
    for c in candidates[1:]:
        if c.direction != best.direction and c.level["score"] == best.level["score"]:
            return None
    return best
