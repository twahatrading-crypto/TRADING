"""Test-only helpers: build hand-specified candle paths and aggregate them into
higher timeframes.  These fixtures exist ONLY for unit tests of the rules;
the application never uses generated data."""
from __future__ import annotations

from datetime import datetime, timezone

from xau.models import Candle, SymbolSpec, TF_SECONDS
from xau.strategy.market import MarketStore
from xau.timeutil import ServerClock

SPEC = SymbolSpec(name="XAUUSD", digits=2, point=0.01, tick_size=0.01, tick_value=1.0,
                  tick_value_loss=1.0, contract_size=100.0, volume_min=0.01, volume_max=100.0,
                  volume_step=0.01, currency_profit="USD", spread_points=20)


def ts(s: str) -> int:
    return int(datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp())


def path(start: int, price: float, segments: list[tuple[int, float]], wick: float = 0.3,
         spread: int = 20) -> list[Candle]:
    """Linear legs: each (n_bars, end_price).  Deterministic."""
    out, t, p = [], start, price
    for n, end in segments:
        step = (end - p) / n
        for _ in range(n):
            o, c = p, p + step
            out.append(Candle(t, round(o, 2), round(max(o, c) + wick, 2), round(min(o, c) - wick, 2),
                              round(c, 2), 100, spread))
            t += 300
            p = c
    return out


def bar(t: int, o: float, h: float, l: float, c: float, spread: int = 20) -> Candle:
    return Candle(t, o, h, l, c, 100, spread)


def aggregate(m5: list[Candle], tf: str, clock: ServerClock | None = None) -> list[Candle]:
    """Aggregate M5 into ``tf``.  D1 buckets follow the broker server day."""
    size = TF_SECONDS[tf]
    buckets: dict[int, list[Candle]] = {}
    for c in m5:
        if tf == "D1" and clock is not None:
            off = clock.offset_at_utc(c.time)
            key = (c.time + off) // 86400 * 86400 - off
        else:
            key = c.time // size * size
        buckets.setdefault(key, []).append(c)
    out = []
    for k in sorted(buckets):
        g = buckets[k]
        out.append(Candle(k, g[0].open, max(x.high for x in g), min(x.low for x in g), g[-1].close,
                          sum(x.tick_volume for x in g), g[-1].spread))
    return out


def make_store(m5: list[Candle], clock: ServerClock | None = None) -> MarketStore:
    clock = clock or ServerClock("NY+7")
    bars = {"M5": m5, "M15": aggregate(m5, "M15"), "H1": aggregate(m5, "H1"),
            "H4": aggregate(m5, "H4"), "D1": aggregate(m5, "D1", clock)}
    return MarketStore(bars=bars, spec=SPEC)


def replace(m5: list[Candle], t: int, o: float, h: float, l: float, c: float) -> None:
    for i, x in enumerate(m5):
        if x.time == t:
            m5[i] = bar(t, o, h, l, c, x.spread)
            return
    raise KeyError(t)
