"""Order-level (MBO) book for ONE instrument, reconstructed only from Databento MBO records.

Databento MBO semantics (GLBX.MDP3), applied exactly:
  A  Add      a new resting order (order_id, side, price, size)
  C  Cancel   removes `size` from the order; the order leaves the book when its size reaches 0
  M  Modify   new price and/or size for an existing order (price change / size increase lose priority).
              A Modify for an order not in the book is applied as an Add (Databento reference behaviour).
  R  Clear    the book is emptied (first record of every snapshot, and on venue resets)
  T  Trade / F Fill / N None   informational - they never change resting orders (CME sends the resulting
              Cancel / Modify separately), so they are not applied.
Records with side N cannot rest in a book and are ignored for book state (counted).

Snapshot validity (never shows an incomplete snapshot as a live book):
  SYNCING   from subscription until the snapshot for this instrument is complete
  VALID     after the snapshot record carrying F_SNAPSHOT | F_LAST (or, defensively, the first live record
            following snapshot records) - only then are price levels published
  DEGRADED  F_MAYBE_BAD_BOOK received, an out-of-order channel sequence, or an inconsistent record
            (cancel/modify of a missing order ...) - the book may be wrong: a fresh snapshot is requested
  INVALID   live records arrived without any snapshot, or the session ended (book frozen, not current)
Price levels are only published at event boundaries (F_LAST), never mid-event.
"""
from __future__ import annotations

from dataclasses import dataclass

F_LAST = 128
F_TOB = 64
F_SNAPSHOT = 32
F_MBP = 16
F_BAD_TS_RECV = 8
F_MAYBE_BAD_BOOK = 4
UNDEF_PRICE = 9223372036854775807
PRICE_SCALE = 1e-9

SYNCING, VALID, DEGRADED, INVALID, NO_DATA = "SYNCING", "VALID", "DEGRADED", "INVALID", "NO_DATA"


def px(raw: int) -> float:
    return round(raw * PRICE_SCALE, 9)


def _s(v: object) -> str:
    """Enum or str -> single-letter code ('A', 'B', ...)."""
    return getattr(v, "value", v) if not isinstance(v, str) else v


@dataclass
class Order:
    side: str
    price: int
    size: int


class OrderBook:
    def __init__(self, instrument_id: int) -> None:
        self.instrument_id = instrument_id
        self.orders: dict[int, Order] = {}
        # side -> price(raw int) -> [total size, order count]
        self.levels: dict[str, dict[int, list[int]]] = {"B": {}, "A": {}}
        self.state = SYNCING
        self.snapshot_seen = False
        self.mid_event = False
        self.dirty: dict[tuple[str, int], None] = {}
        self.epoch = 0
        self.counts = {"applied": 0, "ignored": 0, "anomalies": 0, "clears": 0, "maybeBadBook": 0, "outOfOrder": 0, "malformed": 0}
        self.reason: str | None = None
        self.last_ts_event: int | None = None
        self.last_ts_recv: int | None = None
        self.last_seq: dict[tuple[int, int], int] = {}

    # ------------------------------------------------------------------ levels
    def _level_add(self, side: str, price: int, size: int, orders: int) -> None:
        lv = self.levels[side].get(price)
        if lv is None:
            lv = self.levels[side][price] = [0, 0]
        lv[0] += size
        lv[1] += orders
        if lv[0] <= 0 or lv[1] <= 0:
            del self.levels[side][price]
        self.dirty[(side, price)] = None

    def _clear(self) -> None:
        for side in ("B", "A"):
            for price in self.levels[side]:
                self.dirty[(side, price)] = None
            self.levels[side].clear()
        self.orders.clear()
        self.counts["clears"] += 1

    def _degrade(self, why: str) -> None:
        if self.state == VALID:
            self.state = DEGRADED
        self.reason = why

    # ------------------------------------------------------------------ apply
    def apply(self, r) -> None:
        """Apply one MBO record for this instrument."""
        action = _s(r.action)
        side = _s(r.side)
        flags = int(r.flags or 0)
        self.last_ts_event = r.ts_event
        self.last_ts_recv = r.ts_recv
        snap = bool(flags & F_SNAPSHOT)
        if flags & F_MAYBE_BAD_BOOK:
            self.counts["maybeBadBook"] += 1
            self._degrade("Databento flagged F_MAYBE_BAD_BOOK (possible gap) - resync required")
        # Channel sequence must never go backwards on live records (snapshot records are exempt).
        if not snap:
            ch = (int(getattr(r, "publisher_id", 0) or 0), int(getattr(r, "channel_id", 0) or 0))
            prev = self.last_seq.get(ch)
            seq = int(getattr(r, "sequence", 0) or 0)
            if prev is not None and seq and seq < prev:
                self.counts["outOfOrder"] += 1
                self._degrade(f"Out-of-order channel sequence {seq} < {prev} - resync required")
            if seq:
                self.last_seq[ch] = max(seq, prev or 0)
        # Snapshot state machine.
        if snap:
            if not self.snapshot_seen or self.state in (VALID, DEGRADED, INVALID):
                self.snapshot_seen = True
                if self.state != SYNCING:
                    self.state = SYNCING
        elif self.state == SYNCING:
            if self.snapshot_seen:
                self._valid()  # defensive: live records after snapshot records
            else:
                self.state = INVALID
                self.reason = "Live MBO records arrived without a snapshot - book unknown, resync required"

        if action == "R":
            self._clear()
        elif action in ("T", "F", "N"):
            self.counts["ignored"] += 1
        elif side not in ("B", "A"):
            self.counts["ignored"] += 1
        elif action == "A":
            self._add(r, side)
        elif action == "C":
            self._cancel(r)
        elif action == "M":
            self._modify(r, side)
        else:
            self.counts["malformed"] += 1
            self._degrade(f"Unknown MBO action {action!r}")
        self.counts["applied"] += 1
        self.mid_event = not (flags & F_LAST)
        if snap and flags & F_LAST:
            self._valid()

    def _valid(self) -> None:
        self.state = VALID
        self.reason = None
        self.epoch += 1

    def _bad(self, r) -> bool:
        if r.price == UNDEF_PRICE or r.price is None or r.size is None or r.size < 0:
            self.counts["malformed"] += 1
            self._degrade("Malformed MBO record (undefined price / negative size)")
            return True
        return False

    def _add(self, r, side: str) -> None:
        if self._bad(r):
            return
        oid = int(r.order_id)
        old = self.orders.get(oid)
        if old is not None:
            self.counts["anomalies"] += 1
            self._level_add(old.side, old.price, -old.size, -1)
        self.orders[oid] = Order(side, int(r.price), int(r.size))
        self._level_add(side, int(r.price), int(r.size), 1)

    def _cancel(self, r) -> None:
        o = self.orders.get(int(r.order_id))
        if o is None:
            self.counts["anomalies"] += 1
            self._degrade("Cancel for an order not in the book")
            return
        take = min(int(r.size), o.size)
        o.size -= take
        if o.size <= 0:
            del self.orders[int(r.order_id)]
            self._level_add(o.side, o.price, -take, -1)
        else:
            self._level_add(o.side, o.price, -take, 0)

    def _modify(self, r, side: str) -> None:
        if self._bad(r):
            return
        oid = int(r.order_id)
        o = self.orders.get(oid)
        if o is None:
            return self._add(r, side)
        self._level_add(o.side, o.price, -o.size, -1)
        o.side, o.price, o.size = side, int(r.price), int(r.size)
        if o.size > 0:
            self._level_add(side, o.price, o.size, 1)
        else:
            del self.orders[oid]

    # ------------------------------------------------------------------ views
    @property
    def publishable(self) -> bool:
        return self.state in (VALID, DEGRADED) and not self.mid_event

    def take_dirty(self) -> list[list]:
        """Changed price levels since the last call: [side, price, total size] (size 0 = level removed)."""
        out = [[side, px(price), self.levels[side].get(price, [0, 0])[0]] for (side, price) in self.dirty]
        self.dirty = {}
        return out

    def snapshot(self, depth: int | None = None) -> dict:
        bids = sorted(self.levels["B"].items(), key=lambda kv: -kv[0])
        asks = sorted(self.levels["A"].items(), key=lambda kv: kv[0])
        if depth:
            bids, asks = bids[:depth], asks[:depth]
        return {"bids": [[px(p), v[0], v[1]] for p, v in bids], "asks": [[px(p), v[0], v[1]] for p, v in asks]}

    def invalidate(self, why: str) -> None:
        """Session ended / book no longer current: frozen and never published as live."""
        self.state = INVALID
        self.reason = why

    def best(self) -> tuple[float | None, float | None]:
        b = max(self.levels["B"]) if self.levels["B"] else None
        a = min(self.levels["A"]) if self.levels["A"] else None
        return (px(b) if b is not None else None, px(a) if a is not None else None)
