"""M5 market structure shift (MSS) after a sweep.

SELL: after buy-side liquidity is swept, the *protected low* is the most recent
confirmed M5 swing low that formed before the sweep extreme (the origin of the
leg that ran the liquidity).  A bearish MSS is an M5 candle that **closes**
below that low, after the sweep.  BUY is mirrored.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Optional, Sequence

from ..config import MSSConfig
from ..models import Candle
from .swings import Swing, find_swings


@dataclass
class MSS:
    direction: str
    level: float          # broken structure price
    swing_time: int       # time of the protected swing candle
    break_time: int       # open time of the candle that closed through it
    break_close: float
    bars_after_sweep: int
    close_beyond_atr: float

    def to_dict(self) -> dict:
        return asdict(self)


def protected_swing(m5: Sequence[Candle], extreme_index: int, direction: str,
                    cfg: MSSConfig) -> Optional[Swing]:
    """Most recent confirmed swing before the sweep extreme, using only bars
    that exist in ``m5`` (all closed)."""
    k = cfg.swing_strength
    start = max(0, extreme_index - cfg.lookback_bars)
    window = m5[start:extreme_index + k + 1]   # right-side bars only if already closed
    highs, lows = find_swings(window, k, "M5")
    pool = lows if direction == "SELL" else highs
    pool = [s for s in pool if start + s.index < extreme_index]
    if not pool:
        return None
    s = pool[-1]
    return Swing(start + s.index, s.time, s.price, s.kind, s.confirmed_at)


def check_mss(bar: Candle, swing: Swing, direction: str, bars_after_sweep: int,
              atr_m5: float) -> Optional[MSS]:
    if direction == "SELL" and bar.close < swing.price:
        beyond = swing.price - bar.close
    elif direction == "BUY" and bar.close > swing.price:
        beyond = bar.close - swing.price
    else:
        return None
    return MSS(direction, swing.price, swing.time, bar.time, bar.close, bars_after_sweep,
               beyond / atr_m5 if atr_m5 > 0 else 0.0)
