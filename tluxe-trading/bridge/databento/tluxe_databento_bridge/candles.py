"""Candles for ONE root's CURRENT contract, from Databento `ohlcv-1m` (official bars built from trades).

- Closed M1 bars come only from `ohlcv-1m` records of the current contract's instrument ID (never another
  contract - a roll starts a new, separate history).
- The forming bar (after the last closed bar) is built from the same contract's real trades.
- Higher timeframes are aggregated from M1 on UTC-aligned buckets. Volume = real exchange volume.
Retention is bounded (the replay window, default 24h of M1).
"""
from __future__ import annotations

from collections import OrderedDict

from .book import px

TF_SECONDS = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600, "H4": 14400, "D1": 86400}


class CandleStore:
    def __init__(self, instrument_id: int, max_bars: int = 2880) -> None:
        self.instrument_id = instrument_id
        self.bars: OrderedDict[int, dict] = OrderedDict()  # open time (s) -> bar
        self.forming: dict | None = None
        self.max_bars = max_bars
        self.last_closed: int | None = None

    def on_ohlcv(self, r) -> bool:
        if int(r.instrument_id) != self.instrument_id:
            return False
        t = int(r.ts_event) // 1_000_000_000
        out_of_order = bool(self.bars) and t < next(reversed(self.bars))
        self.bars[t] = {"time": t, "open": px(r.open), "high": px(r.high), "low": px(r.low), "close": px(r.close), "volume": int(r.volume), "isClosed": True}
        if out_of_order:
            self.bars = OrderedDict(sorted(self.bars.items()))
        while len(self.bars) > self.max_bars:
            self.bars.popitem(last=False)
        self.last_closed = max(self.last_closed or t, t)
        if self.forming and self.forming["time"] <= t:
            self.forming = None
        return True

    def on_trade(self, t: dict) -> None:
        sec = t["tsEventNs"] // 1_000_000_000
        open_t = sec - sec % 60
        if self.last_closed is not None and open_t <= self.last_closed:
            return
        f = self.forming
        if f is None or f["time"] != open_t:
            if f is not None and open_t < f["time"]:
                return
            self.forming = f = {"time": open_t, "open": t["price"], "high": t["price"], "low": t["price"], "close": t["price"], "volume": 0, "isClosed": False}
        f["high"] = max(f["high"], t["price"])
        f["low"] = min(f["low"], t["price"])
        f["close"] = t["price"]
        f["volume"] += t["size"]

    def get(self, tf: str, limit: int = 5000) -> list[dict]:
        m1 = list(self.bars.values()) + ([dict(self.forming)] if self.forming else [])
        if tf == "M1":
            return [dict(b) for b in m1[-limit:]]
        sec = TF_SECONDS[tf]
        # Closed M1 coverage ends at the end of the last closed M1 bar.
        closed_until = (self.last_closed + 60) if self.last_closed is not None else None
        out: list[dict] = []
        for b in m1:
            t = b["time"] - b["time"] % sec
            if out and out[-1]["time"] == t:
                o = out[-1]
                o["high"] = max(o["high"], b["high"])
                o["low"] = min(o["low"], b["low"])
                o["close"] = b["close"]
                o["volume"] += b["volume"]
            else:
                out.append({**b, "time": t})
        for o in out:
            # A higher-timeframe bar is closed only when its whole window is covered by closed M1 bars.
            o["isClosed"] = closed_until is not None and o["time"] + sec <= closed_until
        return out[-limit:]
