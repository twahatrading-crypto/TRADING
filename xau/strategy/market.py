"""Normalized candle store and point-in-time snapshots.

``MarketStore`` holds candles per timeframe (from MT5 live fetches or from
stored history).  ``MarketStore.snapshot_at(t)`` returns a ``Snapshot`` that
contains **only candles whose close time is <= t**.  The strategy engine
receives nothing but snapshots, which is what makes look-ahead impossible:
a forming bar or a future bar never reaches any detector.

Live mode and backtest mode both go through this exact code path.
"""
from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass, field
from typing import Optional

from ..models import Candle, SymbolSpec, TF_SECONDS, TIMEFRAMES

# How many closed candles of each TF a snapshot carries (enough for every rule).
DEFAULT_LOOKBACK = {"M1": 60, "M5": 600, "M15": 300, "H1": 200, "H4": 60, "D1": 10}


@dataclass
class Snapshot:
    now: int                                   # UTC; every candle closed at or before this
    bars: dict[str, list[Candle]]
    spec: Optional[SymbolSpec] = None

    def m5(self) -> list[Candle]:
        return self.bars.get("M5", [])

    @property
    def last(self) -> Candle:
        return self.bars["M5"][-1]


@dataclass
class MarketStore:
    bars: dict[str, list[Candle]] = field(default_factory=dict)
    spec: Optional[SymbolSpec] = None
    lookback: dict[str, int] = field(default_factory=lambda: dict(DEFAULT_LOOKBACK))

    def __post_init__(self):
        self._close_times: dict[str, list[int]] = {}
        for tf in list(self.bars):
            self.set_bars(tf, self.bars[tf])

    def set_bars(self, tf: str, candles: list[Candle]) -> None:
        cs = sorted({c.time: c for c in candles}.values(), key=lambda c: c.time)
        self.bars[tf] = cs
        self._close_times[tf] = [c.time + TF_SECONDS[tf] for c in cs]

    def closed_count_at(self, tf: str, t: int) -> int:
        return bisect_right(self._close_times.get(tf, []), t)

    def snapshot_at(self, t: int) -> Snapshot:
        out: dict[str, list[Candle]] = {}
        for tf in TIMEFRAMES:
            if tf not in self.bars:
                continue
            n = self.closed_count_at(tf, t)
            lb = self.lookback.get(tf, 200)
            out[tf] = self.bars[tf][max(0, n - lb):n]
        return Snapshot(now=t, bars=out, spec=self.spec)

    def m5_close_times(self, start: int | None = None, end: int | None = None) -> list[int]:
        ts = self._close_times.get("M5", [])
        return [x for x in ts if (start is None or x >= start) and (end is None or x <= end)]
