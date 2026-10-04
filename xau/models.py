"""Core data types shared by the live feed, the strategy engine and the backtester.

All candle/tick times inside the application are **true UTC epoch seconds**.
MT5 returns timestamps in broker *server* wall-clock time; the conversion to
UTC happens exactly once, in :mod:`xau.timeutil` / :mod:`xau.mt5_feed`.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import NamedTuple, Optional

TF_SECONDS: dict[str, int] = {
    "M1": 60,
    "M5": 300,
    "M15": 900,
    "H1": 3600,
    "H4": 14400,
    "D1": 86400,
}
TIMEFRAMES: list[str] = list(TF_SECONDS)


class Candle(NamedTuple):
    time: int            # bar OPEN time, UTC epoch seconds
    open: float
    high: float
    low: float
    close: float
    tick_volume: int = 0
    spread: int = 0      # spread in points, as reported by MT5 for the bar
    real_volume: int = 0

    @property
    def body(self) -> float:
        return abs(self.close - self.open)

    @property
    def range(self) -> float:
        return self.high - self.low

    @property
    def bullish(self) -> bool:
        return self.close > self.open

    @property
    def bearish(self) -> bool:
        return self.close < self.open


def candle_close_time(c: Candle, tf: str) -> int:
    """UTC time at which the bar is complete."""
    return c.time + TF_SECONDS[tf]


@dataclass
class Tick:
    time: int            # UTC epoch seconds
    time_msc: int        # UTC epoch milliseconds
    bid: float
    ask: float
    last: float
    volume: float = 0.0

    def spread_points(self, point: float) -> float:
        return round((self.ask - self.bid) / point, 1) if point else 0.0


@dataclass
class SymbolSpec:
    """Contract specification, read from MT5 ``symbol_info``. Never assumed."""
    name: str
    description: str = ""
    digits: int = 2
    point: float = 0.01
    tick_size: float = 0.01
    tick_value: float = 0.0
    tick_value_loss: float = 0.0
    contract_size: float = 0.0
    volume_min: float = 0.0
    volume_max: float = 0.0
    volume_step: float = 0.0
    currency_profit: str = ""
    currency_margin: str = ""
    spread_points: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class AccountInfo:
    login: int = 0
    server: str = ""
    company: str = ""
    currency: str = ""
    balance: float = 0.0
    equity: float = 0.0
    trade_mode: str = ""   # DEMO / CONTEST / REAL

    def to_dict(self) -> dict:
        return asdict(self)

    def public_dict(self) -> dict:
        """For UI/logs/evidence: no login number (and MT5 never exposes passwords)."""
        d = asdict(self)
        d.pop("login", None)
        return d


Direction = str  # "BUY" | "SELL"


def opposite(direction: Direction) -> Direction:
    return "SELL" if direction == "BUY" else "BUY"


def round_price(x: Optional[float], digits: int = 2) -> Optional[float]:
    return None if x is None else round(x, digits)
