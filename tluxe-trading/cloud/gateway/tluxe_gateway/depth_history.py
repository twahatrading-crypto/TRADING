"""Server-side IBKR depth history: every depth observation the gateway accepts is persisted (PostgreSQL in
production), independent of any browser, and served back as a time x price liquidity matrix.

Recording (DepthRecorder, fed by IbkrRelay in pull mode):
  snapshot  the full visible book on every (re)sync and every KEYFRAME_MS (replay base)
  delta     each level change between two consecutive IBKR snapshots [ts, side, price, size, pos, op], batched ~1 s;
            a delta row also extends liveness (t1) while the book stays LIVE and unchanged
  gap       the book stopped being trustworthy (stale / offline / reconnecting / contract change / error)
All times are the depth service's lastUpdate (IBKR bridge receive time, UTC ms) - never an exchange timestamp.

Matrix (build_matrix): replays the rows and integrates each displayed level over time. A cell is the TIME-WEIGHTED
displayed resting size observed at that price during the part of the bucket where the book was recorded valid.
Never drawn: time before the first recorded snapshot, time after a gap, time beyond the last confirmation + CARRY_MS
(a crash / restart leaves no rows -> no data), and nothing is interpolated or backfilled.
"""
from __future__ import annotations

import json
import logging
from typing import Callable

log = logging.getLogger("tluxe.gateway.depth")
KEYFRAME_MS = 60_000
KEY_MARGIN_MS = 2_000
# The relay treats a book older than 10 s as STALE; a recorded book is never carried longer than that without a new row.
CARRY_MS = 11_000
MAX_PENDING = 20_000
BUCKETS_MS = (250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000)
MAX_COLUMNS = 4000
MAX_SPAN_MS = 3 * 24 * 3600 * 1000
OP_DELETE, OP_INSERT, OP_UPDATE = 0, 1, 2
BID, ASK = 0, 1


def _dumps(o) -> str:
    return json.dumps(o, separators=(",", ":"))


class _Root:
    def __init__(self, root: str) -> None:
        self.root = root
        self.contract: str | None = None
        self.valid = False
        self.book: tuple[dict[float, tuple[float, int]], dict[float, tuple[float, int]]] = ({}, {})
        self.open: dict | None = None  # the delta row being filled
        self.last_ms: int | None = None  # last confirmed (valid) observation time
        self.last_key_ms: int | None = None
        self.last_change_ms: int | None = None  # IBKR-time of the last recorded level change / snapshot
        self.epoch: int | None = None


class DepthRecorder:
    def __init__(self, store, keyframe_ms: int = KEYFRAME_MS) -> None:
        self.store = store
        self.keyframe_ms = keyframe_ms
        self.roots = {r: _Root(r) for r in ("GC", "SI")}
        self.pending: list[dict] = []
        self.stats: dict[tuple[str, str], dict] = {}
        self.rows_written = 0
        self.write_errors = 0
        self.dropped = 0
        self.last_flush_ms: int | None = None
        self.last_error: str | None = None

    # ------------------------------------------------------------------ recording (called by the relay)
    def _row(self, r: _Root, kind: str, t0: int, t1: int, data, n_obs: int, seq_from=None, seq_to=None) -> dict:
        return {"root": r.root, "contract": r.contract or "", "provider": "IBKR", "kind": kind, "t0": int(t0), "t1": int(t1),
                "epoch": r.epoch, "seqFrom": seq_from, "seqTo": seq_to, "n_obs": n_obs, "data": data if isinstance(data, str) else _dumps(data)}

    def _emit(self, row: dict) -> None:
        if len(self.pending) >= MAX_PENDING:  # the database is unreachable for a long time: oldest unsaved rows dropped (counted)
            self.pending.pop(0)
            self.dropped += 1
        self.pending.append(row)
        k = (row["root"], row["contract"])
        st = self.stats.setdefault(k, {"root": row["root"], "contract": row["contract"], "firstMs": None, "lastMs": None, "rows": 0, "observations": 0})
        if row["kind"] == "snapshot" and (st["firstMs"] is None or row["t0"] < st["firstMs"]):
            st["firstMs"] = row["t0"]
        st["lastMs"] = row["t1"] if st["lastMs"] is None else max(st["lastMs"], row["t1"])
        st["rows"] += 1
        st["observations"] += row["n_obs"]

    def _close_open(self, r: _Root) -> None:
        o = r.open
        r.open = None
        if o is None:
            return
        self._emit(self._row(r, "delta", o["t0"], o["t1"], {"c": o["c"]}, len(o["c"]), o["seqFrom"], o["seqTo"]))

    def _snapshot_row(self, r: _Root, ts: int) -> None:
        bids = [[p, s, pos] for p, (s, pos) in sorted(r.book[BID].items(), key=lambda x: -x[0])]
        asks = [[p, s, pos] for p, (s, pos) in sorted(r.book[ASK].items(), key=lambda x: x[0])]
        self._emit(self._row(r, "snapshot", ts, ts, {"b": bids, "a": asks}, len(bids) + len(asks)))
        r.last_key_ms = ts

    def snapshot(self, root: str, contract: str, ts: int, bids, asks, epoch: int | None = None) -> None:
        """A fresh, trustworthy book (rows of (position, price, size, marketMaker))."""
        r = self.roots[root]
        self._close_open(r)
        if r.valid and r.contract and r.contract != contract:
            self.gap(root, "contract changed")
        r.contract, r.epoch, r.valid = contract, epoch, True
        r.book = ({float(p): (float(s), int(pos)) for pos, p, s, _mm in bids if s > 0},
                  {float(p): (float(s), int(pos)) for pos, p, s, _mm in asks if s > 0})
        r.last_ms = r.last_change_ms = int(ts)
        self._snapshot_row(r, int(ts))

    def changes(self, root: str, ts: int, changes: list, seq_from: int | None = None, seq_to: int | None = None, now: int | None = None) -> None:
        """Level changes between two consecutive IBKR snapshots: (side 'bid'|'ask', price, new size (0 = removed), position).
        ts = IBKR lastUpdate of the snapshot that showed them; now = gateway time of that LIVE poll (liveness)."""
        r = self.roots[root]
        if not r.valid:
            return
        ts = int(ts)
        now = max(int(now if now is not None else ts), ts)
        if r.open is None:
            r.open = {"t0": ts, "t1": ts, "c": [], "seqFrom": seq_from, "seqTo": seq_to}
        o = r.open
        for side, price, size, pos in changes:
            sd = BID if side == "bid" else ASK
            price, size = float(price), float(size)
            had = price in r.book[sd]
            if size > 0:
                r.book[sd][price] = (size, int(pos) if pos is not None else -1)
                op = OP_UPDATE if had else OP_INSERT
            else:
                r.book[sd].pop(price, None)
                op = OP_DELETE
            o["c"].append([ts, sd, price, size, int(pos) if pos is not None else -1, op])
        o["t1"] = max(o["t1"], now)
        if seq_from is not None and o["seqFrom"] is None:
            o["seqFrom"] = seq_from
        if seq_to is not None:
            o["seqTo"] = seq_to
        r.last_ms = max(r.last_ms or now, now)
        r.last_change_ms = max(r.last_change_ms or ts, ts)
        if r.last_key_ms is not None and ts - r.last_key_ms >= self.keyframe_ms:
            self._close_open(r)
            self._snapshot_row(r, ts)

    def alive(self, root: str, now: int) -> None:
        """A LIVE poll re-confirmed the book unchanged at gateway time `now` (extends liveness only)."""
        r = self.roots[root]
        if not r.valid:
            return
        now = int(now)
        if r.open is None:
            r.open = {"t0": now, "t1": now, "c": [], "seqFrom": None, "seqTo": None}
        r.open["t1"] = max(r.open["t1"], now)
        r.last_ms = max(r.last_ms or now, now)
        if r.last_key_ms is not None and now - r.last_key_ms >= self.keyframe_ms:
            # Replay base for a quiet book. Placed KEY_MARGIN_MS before `now` (never before the last change) so a later
            # change stamped by the VPS clock cannot sort before it.
            self._close_open(r)
            self._snapshot_row(r, max(r.last_change_ms or 0, now - KEY_MARGIN_MS, r.last_key_ms + 1))

    def gap(self, root: str, reason: str) -> None:
        """The book stopped being trustworthy. Recorded at the last confirmed time - nothing is claimed beyond it."""
        r = self.roots[root]
        if not r.valid:
            return
        self._close_open(r)
        t = r.last_ms or 0
        self._emit(self._row(r, "gap", t, t, {"reason": str(reason)[:200]}, 0))
        r.valid = False
        r.book = ({}, {})

    # ------------------------------------------------------------------ persistence
    def unflushed(self, root: str, contract: str) -> list[dict]:
        out = [x for x in self.pending if x["root"] == root and x["contract"] == contract]
        r = self.roots[root]
        if r.open is not None and r.contract == contract:
            o = r.open
            out.append(self._row(r, "delta", o["t0"], o["t1"], {"c": list(o["c"])}, len(o["c"])))
        return out

    async def flush(self, now_ms: int | None = None) -> int:
        for r in self.roots.values():
            self._close_open(r)
        if not self.pending:
            return 0
        batch = self.pending[:5000]
        try:
            await self.store.add_depth_rows(batch)
        except Exception as exc:  # noqa: BLE001 - kept pending and retried; never logged with data
            self.write_errors += 1
            self.last_error = type(exc).__name__
            log.warning("IBKR depth history write failed (%s) - %d rows kept for retry", type(exc).__name__, len(self.pending))
            return 0
        del self.pending[: len(batch)]
        self.rows_written += len(batch)
        self.last_flush_ms = now_ms
        return len(batch)

    async def load_stats(self) -> None:
        try:
            for st in await self.store.depth_stats():
                self.stats[(st["root"], st["contract"])] = st
        except Exception as exc:  # noqa: BLE001
            log.warning("IBKR depth history stats unavailable (%s)", type(exc).__name__)

    async def rows(self, root: str, contract: str, from_ms: int, to_ms: int) -> list[dict]:
        stored = await self.store.depth_rows(root, contract, from_ms, to_ms)
        extra = [x for x in self.unflushed(root, contract) if x["t0"] <= to_ms]
        return stored + extra

    def first_ms(self, root: str, contract: str) -> int | None:
        st = self.stats.get((root, contract))
        return st["firstMs"] if st else None

    def status(self) -> dict:
        roots = {}
        for (root, contract), st in sorted(self.stats.items()):
            roots.setdefault(root, {})[contract] = {**st, "durationMs": (st["lastMs"] - st["firstMs"]) if st["firstMs"] and st["lastMs"] else None}
        return {"roots": roots, "pendingRows": len(self.pending), "rowsWritten": self.rows_written, "writeErrors": self.write_errors,
                "lastError": self.last_error, "droppedUnsaved": self.dropped, "lastFlushMs": self.last_flush_ms, "keyframeMs": self.keyframe_ms,
                "recording": {r: {"valid": x.valid, "contract": x.contract, "lastObservedMs": x.last_ms} for r, x in self.roots.items()}}


# ------------------------------------------------------------------ matrix
def build_matrix(rows: list[dict], from_ms: int, to_ms: int, bucket_ms: int, carry_ms: int = CARRY_MS) -> dict:
    """Time x price liquidity matrix from recorded rows (see module doc). Returns the columns with any valid coverage:
    [t, coverage 0..1, [[price, bid size], ...], [[price, ask size], ...]] and the last confirmed time."""
    n = max(0, (to_ms - from_ms + bucket_ms - 1) // bucket_ms)
    acc: list[dict | None] = [None] * n
    cov = [0.0] * n
    book: tuple[dict[float, float], dict[float, float]] = ({}, {})
    valid = False
    cursor = 0
    alive_to = 0

    def integrate(a: int, b: int) -> None:
        a = max(a, from_ms)
        b = min(b, to_ms)
        if b <= a:
            return
        i = (a - from_ms) // bucket_ms
        while a < b and i < n:
            end = min(b, from_ms + (i + 1) * bucket_ms)
            dt = end - a
            if dt > 0:
                cov[i] += dt
                cell = acc[i]
                if cell is None:
                    cell = acc[i] = {}
                for sd in (BID, ASK):
                    for p, s in book[sd].items():
                        k = (sd, p)
                        cell[k] = cell.get(k, 0.0) + s * dt
            a = end
            i += 1

    for row in rows:
        kind, t0 = row["kind"], row["t0"]
        if valid and t0 - alive_to > carry_ms:  # no confirmation for too long (crash / restart): no data in between
            integrate(cursor, alive_to)
            valid = False
        if kind == "gap":
            if valid:
                integrate(cursor, min(max(t0, cursor), alive_to))
            valid = False
            continue
        data = json.loads(row["data"]) if isinstance(row["data"], str) else row["data"]
        if kind == "snapshot":
            if valid:
                integrate(cursor, t0)
            book = ({float(p): float(s) for p, s, *_ in data["b"] if s > 0}, {float(p): float(s) for p, s, *_ in data["a"] if s > 0})
            valid, cursor, alive_to = True, t0, max(row["t1"], t0)
            continue
        if not valid:
            continue  # a delta without a known base book is never applied
        for ts, sd, p, s, _pos, _op in data["c"]:
            ts = max(int(ts), cursor)
            integrate(cursor, ts)
            cursor = ts
            if s > 0:
                book[sd][float(p)] = float(s)
            else:
                book[sd].pop(float(p), None)
        alive_to = max(alive_to, row["t1"], cursor)
    if valid:
        integrate(cursor, alive_to)
    cols = []
    for i in range(n):
        if cov[i] <= 0 or acc[i] is None:
            continue
        c = cov[i]
        bids = sorted(([p, round(v / c, 2)] for (sd, p), v in acc[i].items() if sd == BID and v > 0), key=lambda x: -x[0])
        asks = sorted(([p, round(v / c, 2)] for (sd, p), v in acc[i].items() if sd == ASK and v > 0), key=lambda x: x[0])
        cols.append([from_ms + i * bucket_ms, round(min(1.0, c / bucket_ms), 3), bids, asks])
    return {"columns": cols, "lastObservedMs": alive_to or None}


def normalize_request(from_ms: int, to_ms: int, bucket_ms: int, first_ms: int | None, now_ms: int) -> tuple[int, int, int] | None:
    """Clamp a request to the recorded range, align to the bucket grid and bound its size (None = nothing recorded)."""
    if first_ms is None:
        return None
    b = min((x for x in BUCKETS_MS if x >= bucket_ms), default=BUCKETS_MS[-1])
    to_ms = min(to_ms, now_ms + b)
    from_ms = max(from_ms, first_ms, to_ms - MAX_SPAN_MS)
    from_ms = (from_ms // b) * b
    to_ms = -(-to_ms // b) * b
    if to_ms <= from_ms:
        return None
    if (to_ms - from_ms) // b > MAX_COLUMNS:
        from_ms = to_ms - MAX_COLUMNS * b
    return from_ms, to_ms, b


Clock = Callable[[], float]
