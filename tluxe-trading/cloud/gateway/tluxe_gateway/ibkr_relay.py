"""IBKR COMEX Level-2 depth relay (MARKET DATA ONLY).

  cloud Windows VPS: IB Gateway (127.0.0.1) -> TLUXE IBKR depth bridge -- OUTBOUND wss --> /bridge/ibkr (this module)
  browsers (any device): GET /api/ibkr/status | /api/ibkr/book?root= | /api/ibkr/updates?root=&epoch=&after=

The home PC is never involved: the VPS link connects out to this gateway, browsers only talk to this gateway.

Book rules (never relaxed):
  * the book of a root is built ONLY from the bridge's normalized IBKR messages (`book` snapshot, sequenced `depth`
    price-level changes, `reset`); nothing is inferred from trades or anything else;
  * a depth sequence gap, a reset, a link loss, a stale link or a contract change invalidates the book: it is cleared,
    a new epoch starts and browsers resync - depth of uncertain continuity is never served as current;
  * `valid` is true only while the VPS link is live, IBKR reports that root LIVE and no gap is open.
Security: the link authenticates with a bridge token (only SHA-256 hashes live in the cloud: TLUXE_IBKR_BRIDGE_TOKEN_SHA256),
every message is sequenced + time-checked (replay / skew rejected), and no path from the browser reaches the VPS.
"""
from __future__ import annotations

import collections
import json
import logging
import re
import time
from typing import Callable

log = logging.getLogger("tluxe.gateway.ibkr")
MAX_SKEW_MS = 30_000
STALE_AFTER_S = 30
RING = 20_000  # recent price-level changes kept per root for incremental browser polling
MAX_MESSAGE = 4_000_000
ROOTS = ("GC", "SI")
ACCOUNT_ID = re.compile(r"\b(?:DU|DF|DI|U|F|I)\d{5,10}\b")


def redact(v):
    if isinstance(v, str):
        return ACCOUNT_ID.sub("[account]", v)
    if isinstance(v, dict):
        return {k: redact(x) for k, x in v.items()}
    if isinstance(v, list):
        return [redact(x) for x in v]
    return v


class RootBook:
    def __init__(self, root: str) -> None:
        self.root = root
        self.epoch = 0
        self.seq = 0  # last applied depth sequence
        self.bids: dict[float, float] = {}
        self.asks: dict[float, float] = {}
        self.ring: collections.deque = collections.deque(maxlen=RING)
        self.in_sync = False  # the bridge book baseline is known (snapshot / reset received, no open gap)
        self.contract: dict | None = None
        self.last_depth_ms: int | None = None
        self.reason: str | None = None

    def invalidate(self, reason: str) -> None:
        self.bids.clear()
        self.asks.clear()
        self.ring.clear()
        self.epoch += 1
        self.in_sync = False
        self.reason = reason


class IbkrRelay:
    def __init__(self, keys: tuple = (), clock: Callable[[], float] = time.time) -> None:
        self.keys = keys
        self.clock = clock
        self.ws = None
        self.bridge_id: str | None = None
        self.connected_at: float | None = None
        self.last_rx: float | None = None
        self.rx_seq = 0
        self.tx_seq = 0
        self.health: dict = {}
        self.books = {r: RootBook(r) for r in ROOTS}
        self.targets: dict[str, str] = {}
        self.sent_targets: dict[str, str] = {}
        self.counts = {"rejectedSkew": 0, "rejectedReplay": 0, "linkGaps": 0, "depthGaps": 0, "authRejected": 0, "resets": 0, "snapshots": 0, "changes": 0}
        self.last_detail: str | None = None

    @property
    def configured(self) -> bool:
        return bool(self.keys)

    def now_ms(self) -> int:
        return int(self.clock() * 1000)

    # ------------------------------------------------------------------ link
    def envelope(self, body: dict) -> str:
        self.tx_seq += 1
        return json.dumps({**body, "seq": self.tx_seq, "ts": self.now_ms()}, separators=(",", ":"))

    def validate(self, msg: dict) -> str | None:
        seq, ts = msg.get("seq"), msg.get("ts")
        if not isinstance(seq, int) or not isinstance(ts, int):
            return "MALFORMED"
        if abs(ts - self.now_ms()) > MAX_SKEW_MS:
            self.counts["rejectedSkew"] += 1
            return "TIMESTAMP_SKEW"
        if seq <= self.rx_seq:
            self.counts["rejectedReplay"] += 1
            return "REPLAY_OR_OUT_OF_ORDER"
        if self.rx_seq and seq != self.rx_seq + 1:
            self.counts["linkGaps"] += 1  # link messages lost: every book's continuity is unknown
            for b in self.books.values():
                b.invalidate(f"link sequence gap {self.rx_seq} -> {seq}")
        self.rx_seq = seq
        return None

    async def attach(self, ws, bridge_id: str) -> None:
        if self.ws is not None:
            try:
                await self.ws.close(code=4000, message=b"replaced")
            except Exception:
                pass
        self.ws, self.bridge_id = ws, bridge_id[:64]
        self.connected_at = self.last_rx = self.clock()
        self.rx_seq = self.tx_seq = 0
        self.sent_targets = {}
        self.last_detail = None
        for b in self.books.values():
            b.invalidate("VPS link (re)connected - waiting for the bridge snapshot")

    def detach(self, ws, why: str) -> None:
        if self.ws is ws:
            self.ws = None
            self.last_detail = why
            self.health = {}
            for b in self.books.values():
                b.invalidate(f"VPS link closed ({why})")

    async def send(self, body: dict) -> None:
        if self.ws is not None:
            await self.ws.send_str(self.envelope(body))

    async def on_message(self, raw: str) -> None:
        if len(raw) > MAX_MESSAGE:
            return
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        if not isinstance(msg, dict) or self.validate(msg):
            return
        self.last_rx = self.clock()
        kind = msg.get("type")
        root = msg.get("root")
        b = self.books.get(root) if isinstance(root, str) else None
        if kind == "health" and isinstance(msg.get("session"), dict):
            self.health = redact({"session": msg["session"], "roots": msg.get("roots") if isinstance(msg.get("roots"), dict) else {}})
        elif kind == "contract" and b and isinstance(msg.get("contract"), dict):
            if b.contract and b.contract.get("conId") != msg["contract"].get("conId"):
                b.invalidate("contract changed")
            b.contract = msg["contract"]
        elif kind == "reset" and b and isinstance(msg.get("depthSeq"), int):
            b.invalidate(str(msg.get("reason") or "reset")[:200])
            self.counts["resets"] += 1
            b.seq, b.in_sync = msg["depthSeq"], True  # known baseline: the book is empty; IBKR re-sends rows
        elif kind == "book" and b and isinstance(msg.get("depthSeq"), int):
            b.invalidate("snapshot")
            self.counts["snapshots"] += 1
            if msg.get("valid"):
                b.bids = {float(p): float(s) for p, s in msg.get("bids") or [] if s > 0}
                b.asks = {float(p): float(s) for p, s in msg.get("asks") or [] if s > 0}
            if isinstance(msg.get("contract"), dict):
                b.contract = msg["contract"]
            b.seq, b.in_sync, b.reason = msg["depthSeq"], True, None
        elif kind == "depth" and b and isinstance(msg.get("changes"), list):
            await self._apply(b, msg["changes"])

    async def _apply(self, b: RootBook, changes: list) -> None:
        for c in changes:
            if not isinstance(c, list) or len(c) < 7:
                continue
            seq, side, price, size, _op, _pos, recv = c[:7]
            if not b.in_sync:
                continue  # waiting for a snapshot: never apply onto an unknown book
            if seq != b.seq + 1:
                self.counts["depthGaps"] += 1
                b.invalidate(f"depth sequence gap {b.seq} -> {seq}")
                await self.send({"type": "snapshot", "root": b.root})
                return
            book = b.bids if side == "bid" else b.asks if side == "ask" else None
            if book is None:
                continue
            if size > 0:
                book[float(price)] = float(size)
            else:
                book.pop(float(price), None)
            b.seq = seq
            b.last_depth_ms = int(recv)
            b.ring.append([seq, side, float(price), float(size), int(recv)])
            self.counts["changes"] += 1

    async def tick(self, targets: dict[str, str]) -> None:
        """Every few seconds: stale link check, heartbeat, target contracts (the active Databento contract per root)."""
        ws = self.ws
        if ws is None:
            return
        if self.last_rx is not None and self.clock() - self.last_rx > STALE_AFTER_S:
            log.warning("IBKR bridge link stale (%d s) - closing", STALE_AFTER_S)
            await ws.close(code=4001, message=b"stale")
            self.detach(ws, "stale")
            return
        self.targets = {r: t for r, t in targets.items() if r in ROOTS and t}
        if self.targets and self.targets != self.sent_targets:
            await self.send({"type": "targets", "roots": self.targets})
            self.sent_targets = dict(self.targets)
        await self.send({"type": "heartbeat"})

    # ------------------------------------------------------------------ browser views (read-only, no account data)
    def root_state(self, root: str) -> tuple[str, str | None]:
        if not self.configured:
            return "NOT_CONFIGURED", "IBKR depth bridge not configured (TLUXE_IBKR_BRIDGE_TOKEN_SHA256 unset)"
        if self.ws is None:
            return "OFFLINE", "IBKR VPS bridge link offline" + (f" ({self.last_detail})" if self.last_detail else "")
        s = (self.health.get("session") or {})
        if s.get("state") == "AUTH_REQUIRED":
            return "AUTH_REQUIRED", s.get("detail") or "IB Gateway login / 2FA required on the VPS"
        if s.get("state") in ("OFFLINE", "RECONNECTING", "CONNECTING"):
            return s["state"], s.get("detail")
        r = (self.health.get("roots") or {}).get(root) or {}
        st = r.get("state") or "CONNECTING"
        tgt, c = self.targets.get(root), self.books[root].contract
        if st == "LIVE" and tgt and c and c.get("localSymbol") != tgt:
            return "CONTRACT_MISMATCH", f"IBKR {c.get('localSymbol')} != Databento {tgt} - depth withheld (contracts are never mixed)"
        return {"SUBSCRIBING": "CONNECTING", "RESOLVING": "CONNECTING", "WAITING_TARGET": "CONNECTING", "UNRESOLVED": "CONTRACT_UNRESOLVED"}.get(st, st), r.get("detail")

    def valid(self, root: str) -> bool:
        b = self.books[root]
        return self.root_state(root)[0] == "LIVE" and b.in_sync

    def status(self) -> dict:
        s = self.health.get("session") or {}
        link_stale = self.ws is not None and self.last_rx is not None and self.clock() - self.last_rx > STALE_AFTER_S
        out = {"provider": "IBKR", "exchange": "COMEX", "configured": self.configured,
               "link": {"connected": self.ws is not None, "stale": link_stale, "bridgeId": self.bridge_id,
                        "connectedAtMs": int(self.connected_at * 1000) if self.connected_at else None,
                        "lastMessageMs": int(self.last_rx * 1000) if self.last_rx else None, "detail": self.last_detail},
               "session": {k: s.get(k) for k in ("state", "apiConnected", "ibServerLink", "authRequired", "detail", "lastIbHeartbeatMs", "lastConnectedMs",
                                                  "reconnects", "nextReconnectMs", "lastError")},
               "roots": {}, "counts": dict(self.counts),
               "depthType": "MBP - aggregated price levels (IBKR reqMktDepth, direct COMEX, isSmartDepth=false); order-by-order (MBO) NOT provided",
               "timestampSource": "VPS receive time (IBKR depth rows carry no exchange timestamp)"}
        for root, b in self.books.items():
            st, detail = self.root_state(root)
            r = (self.health.get("roots") or {}).get(root) or {}
            out["roots"][root] = {"state": st, "detail": detail, "valid": self.valid(root), "contract": b.contract, "target": self.targets.get(root),
                                  "bidLevels": len(b.bids), "askLevels": len(b.asks), "depthSeq": b.seq, "epoch": b.epoch, "lastDepthMs": b.last_depth_ms,
                                  "rowsRequested": r.get("rowsRequested"), "ops": r.get("ops"), "marketMakerField": r.get("marketMakerField"), "resetReason": b.reason}
        return out

    def book(self, root: str) -> dict:
        b = self.books[root]
        st, detail = self.root_state(root)
        valid = self.valid(root)
        return {"root": root, "state": st, "detail": detail, "valid": valid, "epoch": b.epoch, "depthSeq": b.seq, "contract": b.contract,
                "lastDepthMs": b.last_depth_ms, "serverMs": self.now_ms(),
                "bids": sorted(([p, s] for p, s in b.bids.items()), key=lambda x: -x[0]) if valid else [],
                "asks": sorted(([p, s] for p, s in b.asks.items()), key=lambda x: x[0]) if valid else []}

    def updates(self, root: str, epoch: int, after: int) -> dict:
        b = self.books[root]
        st, detail = self.root_state(root)
        base = {"root": root, "state": st, "detail": detail, "valid": self.valid(root), "epoch": b.epoch, "depthSeq": b.seq, "serverMs": self.now_ms()}
        if not base["valid"] or epoch != b.epoch or after > b.seq:
            return {**base, "resync": True, "changes": []}
        if after == b.seq:
            return {**base, "resync": False, "changes": []}
        oldest = b.ring[0][0] if b.ring else b.seq + 1
        if after + 1 < oldest:
            return {**base, "resync": True, "changes": []}  # older than the ring: take a fresh book
        return {**base, "resync": False, "changes": [c for c in b.ring if c[0] > after][:5000]}
