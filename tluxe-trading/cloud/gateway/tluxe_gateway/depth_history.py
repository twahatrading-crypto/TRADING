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

import bisect
import json
import logging
import secrets
import time
from typing import Callable

log = logging.getLogger("tluxe.gateway.depth")
KEYFRAME_MS = 60_000
KEY_MARGIN_MS = 2_000
REPLAY_LOOKBACK_MS = KEYFRAME_MS + 15_000
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
        # Recording process id, written into every row: Railway starts a new gateway before stopping the old one, and
        # coverage is resolved per instance (build_matrix) - one process's stop never ends another process's book.
        self.instance = secrets.token_hex(4)
        self.started_ms = int(time.time() * 1000)

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
        st["gaps"] = st.get("gaps", 0) + (1 if row["kind"] == "gap" else 0)

    def _close_open(self, r: _Root) -> None:
        o = r.open
        r.open = None
        if o is None:
            return
        self._emit(self._row(r, "delta", o["t0"], o["t1"], {"c": o["c"], "i": self.instance}, len(o["c"]), o["seqFrom"], o["seqTo"]))

    def _snapshot_row(self, r: _Root, ts: int) -> None:
        bids = [[p, s, pos] for p, (s, pos) in sorted(r.book[BID].items(), key=lambda x: -x[0])]
        asks = [[p, s, pos] for p, (s, pos) in sorted(r.book[ASK].items(), key=lambda x: x[0])]
        self._emit(self._row(r, "snapshot", ts, ts, {"b": bids, "a": asks, "i": self.instance, "v": ROW_FORMAT}, len(bids) + len(asks)))
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
        self._emit(self._row(r, "gap", t, t, {"reason": str(reason)[:200], "i": self.instance}, 0))
        r.valid = False
        r.book = ({}, {})

    # ------------------------------------------------------------------ persistence
    def unflushed(self, root: str, contract: str) -> list[dict]:
        out = [x for x in self.pending if x["root"] == root and x["contract"] == contract]
        r = self.roots[root]
        if r.open is not None and r.contract == contract:
            o = r.open
            out.append(self._row(r, "delta", o["t0"], o["t1"], {"c": list(o["c"]), "i": self.instance}, len(o["c"]), o["seqFrom"], o["seqTo"]))
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
        # Start at a snapshot at least REPLAY_LOOKBACK_MS before `from`, so every instance recording at `from` (a keyframe
        # every KEYFRAME_MS) has its own base snapshot in the rows - never another instance's.
        stored = await self.store.depth_rows(root, contract, from_ms - REPLAY_LOOKBACK_MS, to_ms)
        extra = [x for x in self.unflushed(root, contract) if x["t0"] <= to_ms]
        return stored + extra

    def first_ms(self, root: str, contract: str) -> int | None:
        st = self.stats.get((root, contract))
        return st["firstMs"] if st else None

    def status(self) -> dict:
        roots = {}
        for (root, contract), st in sorted(self.stats.items()):
            roots.setdefault(root, {})[contract] = {**st, "durationMs": (st["lastMs"] - st["firstMs"]) if st["firstMs"] and st["lastMs"] else None}
        return {"roots": roots, "instance": self.instance, "processStartedMs": self.started_ms, "pendingRows": len(self.pending), "rowsWritten": self.rows_written, "writeErrors": self.write_errors,
                "lastError": self.last_error, "droppedUnsaved": self.dropped, "lastFlushMs": self.last_flush_ms, "keyframeMs": self.keyframe_ms,
                "recording": {r: {"valid": x.valid, "contract": x.contract, "lastObservedMs": x.last_ms} for r, x in self.roots.items()}}


# ------------------------------------------------------------------ matrix
# Railway starts the new gateway before stopping the old one: during that overlap two recording processes write rows
# for the same book. Coverage is therefore built PER RECORDING PROCESS (instance) and combined as a union - a stop /
# gap row of one instance ends only that instance's coverage, and no row of one instance ever extends or ends another
# instance's book ("last row wins" across processes is never used). Time with no instance confirming a valid book stays
# no data; nothing is carried, copied or interpolated across it.
ROW_FORMAT = 2  # snapshots carry "v": 2 when every row of that instance (delta rows too) carries its instance id "i"


def _route(rows: list[dict]) -> dict:
    """Split recorded rows into per-instance streams (in recorded order).
    Snapshot / gap rows name their instance. Delta rows written before ROW_FORMAT 2 carry no instance: such a row can
    only come from a valid instance that also writes untagged rows; between several, the relay's own depth sequence
    decides (each process numbers its changes contiguously), then the most recent base snapshot (a liveness-only row
    has no sequence - the pre-format-2 behaviour)."""
    streams: dict = {}
    st: dict = {}
    for row in rows:
        data = json.loads(row["data"]) if isinstance(row["data"], str) else row["data"]
        kind = row["kind"]
        if kind == "snapshot":
            k = data.get("i")
            s = st.setdefault(k, {"seq": None, "tagged": False})
            s.update(valid=True, tagged=(data.get("v") or 1) >= ROW_FORMAT, snap=row["t0"])
        elif kind == "gap":
            k = data.get("i")
            if k in st:
                st[k]["valid"] = False
        else:
            if "i" in data:
                k = data["i"]
            else:
                cands = [c for c, x in st.items() if x.get("valid") and not x["tagged"]]
                if not cands:
                    continue  # a delta without a known base book is never applied
                sf = row.get("seqFrom")
                k = next((c for c in cands if sf is not None and st[c]["seq"] is not None and st[c]["seq"] + 1 == sf), None)
                if k is None and sf is not None:
                    k = next((c for c in sorted(cands, key=lambda c: -st[c]["snap"]) if st[c]["seq"] is None), None)
                if k is None:
                    k = max(cands, key=lambda c: st[c]["snap"])
            if k in st and row.get("seqTo") is not None:
                st[k]["seq"] = row["seqTo"]
        streams.setdefault(k, []).append((row, data))
    return streams


def _replay(items: list, carry_ms: int, emit, books: bool = True) -> int:
    """One instance's rows -> emit(a, b, book) for every interval of confirmed valid book. Returns its last confirmation.
    books=False: validity only (the book is not maintained - interval pass)."""
    book: tuple[dict[float, float], dict[float, float]] = ({}, {})
    valid = False
    cursor = alive_to = last = 0
    for row, data in items:
        kind, t0 = row["kind"], row["t0"]
        if valid and t0 - alive_to > carry_ms:  # no confirmation for too long (crash / hang): no data in between
            emit(cursor, alive_to, book)
            valid = False
        if kind == "gap":
            if valid:
                emit(cursor, min(max(t0, cursor), alive_to), book)
            valid = False
            continue
        if kind == "snapshot":
            if valid:
                emit(cursor, t0, book)
            if books:
                book = ({float(p): float(s) for p, s, *_ in data["b"] if s > 0}, {float(p): float(s) for p, s, *_ in data["a"] if s > 0})
            valid, cursor, alive_to = True, t0, max(row["t1"], t0)
            last = max(last, alive_to)
            continue
        if not valid:
            continue
        if not books:
            c = data["c"]
            if c:
                nc = max(cursor, max(int(x[0]) for x in c))
                emit(cursor, nc, book)  # the same covered span as the per-change emits of the book pass
                cursor = nc
            alive_to = max(alive_to, row["t1"], cursor)
            last = max(last, alive_to)
            continue
        for ts, sd, p, s, _pos, _op in data["c"]:
            ts = max(int(ts), cursor)
            emit(cursor, ts, book)
            cursor = ts
            if s > 0:
                book[sd][float(p)] = float(s)
            else:
                book[sd].pop(float(p), None)
        alive_to = max(alive_to, row["t1"], cursor)
        last = max(last, alive_to)
    if valid:
        emit(cursor, alive_to, book)
    return last


def _intervals(items: list, carry_ms: int) -> tuple[list[list[int]], int]:
    out: list[list[int]] = []

    def emit(a, b, _book):
        if b <= a:
            return
        if out and out[-1][1] >= a:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    last = _replay(items, carry_ms, emit, books=False)
    return out, last


def _assign(ivs: dict) -> dict:
    """Which instance's recorded book is drawn when: the union of all instances' valid time, each moment given to ONE
    instance (the current one is kept while it stays valid, so books of two processes are never mixed or summed)."""
    edges = sorted({x for v in ivs.values() for iv in v for x in iv})
    out: dict = {k: [] for k in ivs}
    cur = None
    for a, b in zip(edges, edges[1:]):
        live = [k for k, v in ivs.items() if any(x <= a and b <= y for x, y in v)]
        if not live:
            cur = None
            continue
        if cur not in live:
            cur = min(live, key=lambda k: min(x for x, y in ivs[k] if x <= a and b <= y))  # the longest-running one
        seg = out[cur]
        if seg and seg[-1][1] == a:
            seg[-1][1] = b
        else:
            seg.append([a, b])
    return out


def coverage_timeline(rows: list[dict], from_ms: int, to_ms: int, carry_ms: int = CARRY_MS) -> dict:
    """Per-instance confirmed-valid intervals, their union and every gap row in [from, to) - no depth values."""
    streams = _route(rows)
    ivs, info = {}, {}
    for k, items in streams.items():
        iv, last = _intervals(items, carry_ms)
        ivs[k] = iv
        snaps = [r["t0"] for r, _ in items if r["kind"] == "snapshot"]
        info["legacy" if k is None else k] = {
            "intervals": [[max(a, from_ms), min(b, to_ms)] for a, b in iv if b > from_ms and a < to_ms],
            "firstSnapshotMs": min(snaps) if snaps else None, "lastConfirmedMs": last or None,
            "rowFormat": ROW_FORMAT if any((d.get("v") or 1) >= ROW_FORMAT for r, d in items if r["kind"] == "snapshot") else 1}
    union: list[list[int]] = []
    for a, b in sorted(x for v in ivs.values() for x in v):
        if union and union[-1][1] >= a:
            union[-1][1] = max(union[-1][1], b)
        else:
            union.append([a, b])
    gaps = [{"t": r["t0"], "reason": d.get("reason"), "i": d.get("i")} for items in streams.values() for r, d in items
            if r["kind"] == "gap" and from_ms <= r["t0"] < to_ms]
    return {"instances": info, "union": [[max(a, from_ms), min(b, to_ms)] for a, b in union if b > from_ms and a < to_ms],
            "gaps": sorted(gaps, key=lambda g: g["t"])}


def build_matrix(rows: list[dict], from_ms: int, to_ms: int, bucket_ms: int, carry_ms: int = CARRY_MS) -> dict:
    """Time x price liquidity matrix from recorded rows (see module doc). Returns the columns with any valid coverage:
    [t, coverage 0..1, [[price, bid size], ...], [[price, ask size], ...], [[valid from, valid to], ...]] and the last
    confirmed time. The intervals are exact: a renderer paints a bucket only inside them (never before the first
    record, never across a gap inside a coarse bucket). Coverage = union of the recording instances (see above)."""
    n = max(0, (to_ms - from_ms + bucket_ms - 1) // bucket_ms)
    acc: list[dict | None] = [None] * n
    cov = [0.0] * n
    segs: list[list[list[int]] | None] = [None] * n  # exact recorded-valid intervals inside each bucket

    def integrate(a: int, b: int, book) -> None:
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
                sg = segs[i]
                if sg is None:
                    segs[i] = [[a, end]]
                elif sg[-1][1] >= a:
                    sg[-1][1] = max(sg[-1][1], end)
                else:
                    sg.append([a, end])
                cell = acc[i]
                if cell is None:
                    cell = acc[i] = {}
                for sd in (BID, ASK):
                    for p, s in book[sd].items():
                        k = (sd, p)
                        cell[k] = cell.get(k, 0.0) + s * dt
            a = end
            i += 1

    streams = _route(rows)
    ivs, last = {}, 0
    for k, items in streams.items():
        ivs[k], lk = _intervals(items, carry_ms)
        last = max(last, lk)
    owned = _assign(ivs)
    for k, items in streams.items():
        mine = owned.get(k) or []
        if not mine:
            continue

        starts = [x for x, _ in mine]

        def emit(a, b, book, mine=mine, starts=starts):
            j = max(0, bisect.bisect_right(starts, a) - 1)
            while j < len(mine) and mine[j][0] < b:  # only while this instance is the one drawn
                x, y = mine[j]
                if y > a:
                    integrate(max(a, x), min(b, y), book)
                j += 1
        _replay(items, carry_ms, emit)
    cols = []
    for i in range(n):
        if cov[i] <= 0 or acc[i] is None:
            continue
        c = cov[i]
        bids = sorted(([p, round(v / c, 2)] for (sd, p), v in acc[i].items() if sd == BID and v > 0), key=lambda x: -x[0])
        asks = sorted(([p, round(v / c, 2)] for (sd, p), v in acc[i].items() if sd == ASK and v > 0), key=lambda x: x[0])
        cols.append([from_ms + i * bucket_ms, round(min(1.0, c / bucket_ms), 3), bids, asks, segs[i]])
    return {"columns": cols, "lastObservedMs": last or None}


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
