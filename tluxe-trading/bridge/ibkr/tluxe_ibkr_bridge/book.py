"""Position-based IBKR market-depth book (one side = an ordered list of rows).

IBKR `updateMktDepth(reqId, position, operation, side, price, size)` is ROW based, not price keyed:
  operation 0 = INSERT  a row at `position` (rows below shift down)
  operation 1 = UPDATE  the row at `position`
  operation 2 = DELETE  the row at `position` (rows below shift up)
  side      0 = ASK, 1 = BID
This module applies exactly those semantics and derives the resulting PRICE-LEVEL changes (new size per price, 0 =
level removed) - the normalized form TLUXE's order-flow engine consumes. Nothing is inferred: a row operation that
does not fit the current book (update / delete of a row that does not exist, insert beyond the end) means the book is
no longer trustworthy -> `BookInconsistent` and the caller clears the book and resubscribes.
No individual orders exist here: IBKR depth rows are aggregated price levels (market maker / exchange tag at most).
"""
from __future__ import annotations

from dataclasses import dataclass, field

INSERT, UPDATE, DELETE = 0, 1, 2
ASK, BID = 0, 1
OPS = {INSERT: "insert", UPDATE: "update", DELETE: "delete"}
SIDES = {ASK: "ask", BID: "bid"}


class BookInconsistent(Exception):
    """A row operation does not fit the book - continuity is uncertain."""


@dataclass
class Row:
    price: float
    size: float
    mm: str = ""  # market maker / exchange tag, only when IBKR supplies one


@dataclass
class DepthBook:
    rows: int
    bids: list[Row] = field(default_factory=list)
    asks: list[Row] = field(default_factory=list)
    duplicate_prices: int = 0

    def side_rows(self, side: int) -> list[Row]:
        if side == BID:
            return self.bids
        if side == ASK:
            return self.asks
        raise BookInconsistent(f"unknown side {side}")

    def levels(self, side: int) -> dict[float, float]:
        """Price -> displayed size. A price listed twice (should not happen on an exchange MBP book) keeps the best
        (lowest) row and is counted - never summed, which would double displayed liquidity."""
        out: dict[float, float] = {}
        for r in self.side_rows(side):
            if r.price in out:
                self.duplicate_prices += 1
                continue
            if r.size > 0:
                out[r.price] = r.size
        return out

    def apply(self, position: int, operation: int, side: int, price: float, size: float, mm: str = "") -> list[tuple[str, float, float]]:
        """Apply one IBKR row operation. Returns the price-level changes [(side, price, newSize)] (0 = removed)."""
        rows = self.side_rows(side)
        before = self.levels(side)
        if position < 0:
            raise BookInconsistent(f"negative position {position}")
        if operation == INSERT:
            if position > len(rows):
                raise BookInconsistent(f"insert at {position} beyond {len(rows)} rows")
            rows.insert(position, Row(price, size, mm))
            del rows[self.rows:]  # IBKR keeps at most `rows` rows; anything pushed past the end is gone
        elif operation == UPDATE:
            if position >= len(rows):
                raise BookInconsistent(f"update of missing row {position} (have {len(rows)})")
            rows[position] = Row(price, size, mm)
        elif operation == DELETE:
            if position >= len(rows):
                raise BookInconsistent(f"delete of missing row {position} (have {len(rows)})")
            del rows[position]
        else:
            raise BookInconsistent(f"unknown operation {operation}")
        after = self.levels(side)
        name = SIDES[side]
        changes = [(name, p, after.get(p, 0.0)) for p in sorted(set(before) | set(after)) if before.get(p) != after.get(p)]
        return changes

    def clear(self) -> None:
        self.bids.clear()
        self.asks.clear()

    def snapshot(self) -> dict:
        bids = sorted(self.levels(BID).items(), key=lambda x: -x[0])
        asks = sorted(self.levels(ASK).items(), key=lambda x: x[0])
        return {"bids": [[p, s] for p, s in bids], "asks": [[p, s] for p, s in asks]}

    def crossed(self) -> bool:
        b, a = self.levels(BID), self.levels(ASK)
        return bool(b and a and max(b) >= min(a))
