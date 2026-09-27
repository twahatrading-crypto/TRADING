"""Trade tape (Databento `trades` schema) for ONE root's current contract, with exact replay de-duplication.

Aggressor classification comes from the SOURCE side field only (Databento: side = the side that initiated the
trade): B -> BUY aggressor (hits the ask: ASK volume), A -> SELL aggressor (hits the bid: BID volume),
N -> UNKNOWN (never guessed, never split).

Recovery: after a disconnect the trades subscription is re-opened with Databento intraday replay starting a
little BEFORE the last processed trade (overlap). Every trade has a de-dup key (instrument, ts_event, ts_recv,
sequence, price, size, side, ts_in_delta) + its occurrence index within the stream, so replayed records that
were already processed are dropped exactly once each and genuine identical prints are never merged. The key
set only covers the overlap window (bounded memory).
"""
from __future__ import annotations

from collections import deque

from .book import UNDEF_PRICE, _s, px

OVERLAP_NS = 60 * 1_000_000_000  # replay overlap before the last processed trade
KEY_WINDOW_NS = 3 * OVERLAP_NS  # keys kept for trades newer than (newest - window)


class TradeTape:
    def __init__(self, root: str, contract: str, instrument_id: int, max_trades: int) -> None:
        self.root = root
        self.contract = contract
        self.instrument_id = instrument_id
        self.trades: deque = deque(maxlen=max_trades)
        self.index = 0  # bridge transport index (NOT an exchange sequence number)
        self.keys: dict[tuple, int] = {}
        self.key_order: deque = deque()
        self.occ: dict[tuple, int] = {}
        self.last_ts_event: int | None = None
        self.last_ts_recv: int | None = None
        self.counts = {"accepted": 0, "duplicates": 0, "malformed": 0, "unknownSide": 0}
        self.volume = {"buy": 0, "sell": 0, "unknown": 0}

    def reset_occurrences(self) -> None:
        """A new session starts counting identical records from zero (replayed records align with the originals)."""
        self.occ = {}

    def replay_start_ns(self) -> int | None:
        return None if self.last_ts_event is None else self.last_ts_event - OVERLAP_NS

    def _prune(self) -> None:
        if self.last_ts_event is None:
            return
        cutoff = self.last_ts_event - KEY_WINDOW_NS
        while self.key_order and self.key_order[0][0] < cutoff:
            _, k = self.key_order.popleft()
            self.keys.pop(k, None)

    def add(self, r) -> dict | None:
        """Returns the normalized trade, or None when duplicate / malformed."""
        side = _s(r.side)
        if r.price == UNDEF_PRICE or r.price is None or not r.size or r.size <= 0 or side not in ("A", "B", "N"):
            self.counts["malformed"] += 1
            return None
        base = (int(r.instrument_id), int(r.ts_event), int(r.ts_recv), int(getattr(r, "sequence", 0) or 0), int(r.price), int(r.size), side, int(getattr(r, "ts_in_delta", 0) or 0))
        n = self.occ.get(base, 0)
        self.occ[base] = n + 1
        if len(self.occ) > 200_000:
            self.occ = {base: n + 1}
        key = (*base, n)
        if key in self.keys:
            self.counts["duplicates"] += 1
            return None
        if self.last_ts_event is not None and int(r.ts_event) < self.last_ts_event - KEY_WINDOW_NS:
            # Older than the de-dup window: could only be a replay of already-processed history.
            self.counts["duplicates"] += 1
            return None
        self.keys[key] = 1
        self.key_order.append((int(r.ts_event), key))
        self.index += 1
        aggr = "BUY" if side == "B" else "SELL" if side == "A" else "UNKNOWN"
        if aggr == "UNKNOWN":
            self.counts["unknownSide"] += 1
        self.volume["buy" if aggr == "BUY" else "sell" if aggr == "SELL" else "unknown"] += int(r.size)
        t = {
            "i": self.index,
            "tsEventNs": int(r.ts_event),
            "tsRecvNs": int(r.ts_recv),
            "price": px(int(r.price)),
            "size": int(r.size),
            "side": side,
            "aggressor": aggr,
            "sequence": int(getattr(r, "sequence", 0) or 0),
            "key": "-".join(str(x) for x in key[1:]),
            "contract": self.contract,
        }
        self.trades.append(t)
        self.counts["accepted"] += 1
        if self.last_ts_event is None or int(r.ts_event) > self.last_ts_event:
            self.last_ts_event = int(r.ts_event)
        if self.last_ts_recv is None or int(r.ts_recv) > self.last_ts_recv:
            self.last_ts_recv = int(r.ts_recv)
        if self.counts["accepted"] % 512 == 0:
            self._prune()
        return t

    def since(self, index: int, limit: int = 20_000) -> tuple[list, bool]:
        """Trades after a transport index. `complete` is False when older trades already left the ring."""
        if not self.trades:
            return [], index >= self.index
        first = self.trades[0]["i"]
        complete = index + 1 >= first or index >= self.index
        out = [t for t in self.trades if t["i"] > index][:limit]
        return out, complete
