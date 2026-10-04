"""Displacement: a meaningful, impulsive move in the trade direction.

A candle qualifies (rule ``single``) only if ALL of:
  * direction matches the setup (bearish candle for SELL),
  * body >= ``min_body_atr`` x ATR(M5) measured *before* the candle,
  * body >= ``min_body_median`` x median body of the previous N candles,
  * close location in the outer ``max_close_location`` of the range
    (SELL: close near the low).
Alternatively (rule ``consecutive``) a run of >= ``consecutive_min``
directional candles, each closing in its own half of the range, whose
bodies sum to >= ``consecutive_total_body_atr`` x ATR.

Both rules are evaluated only on the leg from the sweep extreme up to the
MSS (+ a few bars), so the move must also be the one that broke structure.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Optional, Sequence

from ..config import DisplacementConfig
from ..models import Candle
from .indicators import atr, close_location, median_body


@dataclass
class Displacement:
    direction: str
    rule: str                 # "single" | "consecutive"
    start_time: int
    end_time: int
    best_body_atr: float
    best_body_median: float
    best_close_location: float  # expressed for the setup direction: 0 = perfect
    consecutive: int
    total_body_atr: float

    def to_dict(self) -> dict:
        return asdict(self)


def _dir_ok(c: Candle, direction: str) -> bool:
    return c.bearish if direction == "SELL" else c.bullish


def _loc(c: Candle, direction: str) -> float:
    cl = close_location(c)
    return cl if direction == "SELL" else 1.0 - cl


def find_displacement(m5: Sequence[Candle], start: int, end: int, direction: str,
                      cfg: DisplacementConfig) -> Optional[Displacement]:
    """Search ``m5[start..end]`` (inclusive, all closed)."""
    end = min(end, len(m5) - 1)
    best: Optional[Displacement] = None
    # rule 1: single displacement candle
    for i in range(max(start, 1), end + 1):
        c = m5[i]
        if not _dir_ok(c, direction):
            continue
        a = atr(m5, cfg.atr_period, end=i)          # ATR known before this candle
        mb = median_body(m5, cfg.median_body_period, end=i)
        if a <= 0:
            continue
        b_atr = c.body / a
        b_med = c.body / mb if mb > 0 else float("inf")
        loc = _loc(c, direction)
        if b_atr >= cfg.min_body_atr and b_med >= cfg.min_body_median and loc <= cfg.max_close_location:
            cand = Displacement(direction, "single", c.time, c.time, b_atr, min(b_med, 99.0), loc, 1, b_atr)
            if best is None or cand.best_body_atr > best.best_body_atr:
                best = cand
    if best:
        return best
    # rule 2: consecutive directional candles
    run: list[int] = []
    for i in range(max(start, 1), end + 2):
        ok = i <= end and _dir_ok(m5[i], direction) and _loc(m5[i], direction) <= 0.5
        if ok:
            run.append(i)
            continue
        if len(run) >= cfg.consecutive_min:
            a = atr(m5, cfg.atr_period, end=run[0])
            mb = median_body(m5, cfg.median_body_period, end=run[0])
            total = sum(m5[j].body for j in run)
            if a > 0 and total / a >= cfg.consecutive_total_body_atr:
                big = max(run, key=lambda j: m5[j].body)
                return Displacement(direction, "consecutive", m5[run[0]].time, m5[run[-1]].time,
                                    m5[big].body / a,
                                    min(m5[big].body / mb, 99.0) if mb > 0 else 99.0,
                                    _loc(m5[big], direction), len(run), total / a)
        run = []
    return None
