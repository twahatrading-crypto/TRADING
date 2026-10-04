"""Three-candle Fair Value Gap created by the displacement leg.

Bearish FVG (SELL): candle[m-1].low > candle[m+1].high and candle[m] is bearish.
    zone = [candle[m+1].high, candle[m-1].low]
Bullish FVG (BUY): candle[m-1].high < candle[m+1].low and candle[m] is bullish.
    zone = [candle[m-1].high, candle[m+1].low]
The FVG exists only once candle m+1 has closed.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Optional, Sequence

from ..config import FVGConfig
from ..models import Candle


@dataclass
class FVG:
    direction: str
    top: float
    bottom: float
    c1_time: int
    c2_time: int
    c3_time: int
    c3_index: int
    size: float
    size_atr: float

    @property
    def mid(self) -> float:
        return (self.top + self.bottom) / 2

    def to_dict(self) -> dict:
        d = asdict(self)
        d["mid"] = self.mid
        return d


def find_fvgs(m5: Sequence[Candle], first_mid: int, last_third: int, direction: str,
              cfg: FVGConfig, atr_m5: float, point: float) -> list[FVG]:
    """FVGs whose middle candle index >= first_mid and third candle index <= last_third."""
    last_third = min(last_third, len(m5) - 1)
    min_size = max(cfg.min_size_atr * atr_m5, cfg.min_size_points * point)
    out: list[FVG] = []
    for m in range(max(first_mid, 1), last_third):
        c1, c2, c3 = m5[m - 1], m5[m], m5[m + 1]
        if direction == "SELL":
            if not (c2.bearish and c1.low > c3.high):
                continue
            top, bottom = c1.low, c3.high
        else:
            if not (c2.bullish and c1.high < c3.low):
                continue
            top, bottom = c3.low, c1.high
        size = top - bottom
        if size < min_size:
            continue
        out.append(FVG(direction, top, bottom, c1.time, c2.time, c3.time, m + 1, size,
                       size / atr_m5 if atr_m5 > 0 else 0.0))
    return out


def touched_since(m5: Sequence[Candle], fvg: FVG, price: float) -> bool:
    """Has any candle after the FVG's third candle traded to ``price``?"""
    for c in m5[fvg.c3_index + 1:]:
        if fvg.direction == "SELL" and c.high >= price:
            return True
        if fvg.direction == "BUY" and c.low <= price:
            return True
    return False


def select_fvg(cands: list[FVG]) -> Optional[FVG]:
    """Largest gap wins; ties -> most recent. Deterministic."""
    if not cands:
        return None
    return sorted(cands, key=lambda f: (-round(f.size, 6), -f.c3_time))[0]
