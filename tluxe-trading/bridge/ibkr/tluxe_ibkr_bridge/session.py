"""IBKR depth session - the vendor-facing state machine (no I/O here; clock and API are injected).

Inputs: IB Gateway API events (connected / disconnected / error / contract details / depth rows / current time) and
gateway link events (target contracts, snapshot requests). Outputs: normalized link messages (`emit`) and API commands.

Rules (never relaxed):
  * a book is only published while its continuity is known: any doubt (disconnect, 317 reset, 1101/1102 restore,
    farm loss, inconsistent row operation, stale silence, contract change) CLEARS it and emits `reset` first;
  * nothing is inferred: rows come only from updateMktDepth / updateMktDepthL2; no order ids, no synthetic levels;
  * IBKR supplies no exchange timestamp on depth rows - every change carries the VPS RECEIVE time (`recvMs`).
"""
from __future__ import annotations

import itertools
import logging
import time
from dataclasses import dataclass, field
from typing import Callable, Protocol

from .book import OPS, BookInconsistent, DepthBook
from .codes import classify, redact
from .contracts import Resolved, Unresolved, select_contract

log = logging.getLogger("tluxe.ibkr.session")

STALE_AFTER_S = 20.0  # no depth row for this long while subscribed -> STALE (book cleared, resubscribed)
RESUBSCRIBE_MIN_S = 60.0  # at most one stale resubscribe per minute (a closed market stays STALE, honestly)
FLUSH_MAX = 500  # changes per depth message


class Api(Protocol):
    def request_contract(self, req_id: int, root: str, local_symbol: str) -> None: ...
    def request_depth(self, req_id: int, c: Resolved, rows: int) -> None: ...
    def cancel_depth(self, req_id: int) -> None: ...


@dataclass
class RootState:
    root: str
    rows: int
    state: str = "WAITING_TARGET"  # WAITING_TARGET RESOLVING SUBSCRIBING LIVE STALE NOT_ENTITLED UNRESOLVED OFFLINE
    target: str | None = None
    contract: Resolved | None = None
    contract_req: int | None = None
    depth_req: int | None = None
    details: list[dict] = field(default_factory=list)
    book: DepthBook | None = None
    seq: int = 0
    pending: list[list] = field(default_factory=list)
    last_depth_s: float | None = None
    subscribed_at_s: float | None = None
    last_resubscribe_s: float | None = None
    updates: int = 0
    resets: int = 0
    ops: dict = field(default_factory=lambda: {"insert": 0, "update": 0, "delete": 0})
    market_makers_seen: bool = False
    detail: str | None = None

    def __post_init__(self) -> None:
        self.book = DepthBook(self.rows)


class DepthSession:
    def __init__(self, api: Api, emit: Callable[[dict], None], roots: tuple[str, ...] = ("GC", "SI"), rows: int = 10,
                 clock: Callable[[], float] = time.time) -> None:
        self.api, self.emit, self.clock = api, emit, clock
        self.rows = rows
        self.roots = {r: RootState(r, rows) for r in roots}
        self.req_ids = itertools.count(1001)
        self.by_req: dict[int, tuple[str, str]] = {}  # req id -> (root, "contract" | "depth")
        self.connected = False
        self.link_down = False
        self.state = "CONNECTING"  # CONNECTING LIVE STALE RECONNECTING AUTH_REQUIRED OFFLINE NOT_ENTITLED
        self.detail: str | None = None
        self.server_version: int | None = None
        self.last_ib_heartbeat_s: float | None = None
        self.last_error: dict | None = None
        self.reconnects = 0
        self.next_reconnect_s: float | None = None
        self.last_connected_s: float | None = None

    # ------------------------------------------------------------------ helpers
    def _ms(self, s: float | None) -> int | None:
        return int(s * 1000) if s is not None else None

    def _reset(self, rs: RootState, reason: str) -> None:
        """Clear the book and tell the cloud BEFORE anything else - never keep uncertain depth."""
        rs.book.clear()
        rs.pending.clear()
        rs.resets += 1
        rs.seq += 1
        self.emit({"type": "reset", "root": rs.root, "depthSeq": rs.seq, "reason": reason, "recvMs": self._ms(self.clock())})

    def _cancel(self, rs: RootState) -> None:
        if rs.depth_req is not None:
            try:
                self.api.cancel_depth(rs.depth_req)
            except Exception:  # pragma: no cover - the socket may already be gone
                pass
            self.by_req.pop(rs.depth_req, None)
            rs.depth_req = None

    def _resolve(self, rs: RootState) -> None:
        if not self.connected or not rs.target:
            rs.state = "WAITING_TARGET" if not rs.target else rs.state
            return
        rid = next(self.req_ids)
        self.by_req[rid] = (rs.root, "contract")
        rs.contract_req, rs.details, rs.state, rs.detail = rid, [], "RESOLVING", None
        self.api.request_contract(rid, rs.root, rs.target)

    def _subscribe(self, rs: RootState) -> None:
        self._cancel(rs)
        rid = next(self.req_ids)
        self.by_req[rid] = (rs.root, "depth")
        rs.depth_req, rs.state = rid, "SUBSCRIBING"
        rs.subscribed_at_s = self.clock()
        rs.last_depth_s = None
        self.api.request_depth(rid, rs.contract, self.rows)

    def _derive_state(self) -> None:
        if not self.connected:
            return
        roots = list(self.roots.values())
        if self.link_down:
            self.state = "RECONNECTING"
        elif roots and all(r.state == "NOT_ENTITLED" for r in roots):
            self.state = "NOT_ENTITLED"
        elif any(r.state == "LIVE" for r in roots):
            self.state = "LIVE"
        elif any(r.state == "STALE" for r in roots):
            self.state = "STALE"
        else:
            self.state = "CONNECTING"

    # ------------------------------------------------------------------ IB Gateway API events
    def on_connecting(self) -> None:
        self.state = "CONNECTING" if not self.reconnects else "RECONNECTING"

    def on_connected(self, server_version: int | None) -> None:
        self.connected, self.link_down = True, False
        self.server_version = server_version
        self.last_connected_s = self.last_ib_heartbeat_s = self.clock()
        self.next_reconnect_s = None
        self.detail = None
        for rs in self.roots.values():
            self._reset(rs, "api connected - book rebuilt from a fresh subscription")
            rs.contract = None
            self._resolve(rs)
        self._derive_state()

    def on_disconnected(self, why: str, auth_required: bool = False, next_retry_s: float | None = None) -> None:
        was = self.connected
        self.connected = False
        self.by_req.clear()
        for rs in self.roots.values():
            if was or rs.book.bids or rs.book.asks:
                self._reset(rs, f"api disconnected - {why}")
            rs.depth_req = rs.contract_req = None
            rs.state = "OFFLINE"
        self.reconnects += 1 if was else 0
        self.state = "AUTH_REQUIRED" if auth_required else "OFFLINE"
        self.detail = why
        self.next_reconnect_s = next_retry_s

    def on_ib_heartbeat(self) -> None:
        self.last_ib_heartbeat_s = self.clock()

    def on_error(self, req_id: int, code: int, message: str) -> None:
        message = redact(str(message))
        c = classify(code)
        self.last_error = {"code": int(code), "message": str(message)[:300], "atMs": self._ms(self.clock()), "action": c.action}
        root_kind = self.by_req.get(req_id)
        rs = self.roots.get(root_kind[0]) if root_kind else None
        if c.action == "INFO":
            return
        log.warning("IBKR %s (req %s): %s - %s", code, req_id, c.label, message)
        if c.action == "RESET_ROOT" and rs:
            self._reset(rs, f"IBKR {code}: {c.label}")  # IB re-sends the book as fresh INSERT rows after this
        elif c.action == "NOT_ENTITLED" and rs:
            self._cancel(rs)
            self._reset(rs, f"IBKR {code}: {c.label}")
            rs.state, rs.detail = "NOT_ENTITLED", f"IBKR {code}: {message}"
        elif c.action == "CONTRACT" and rs:
            rs.state, rs.detail = "UNRESOLVED", f"IBKR {code}: {message}"
        elif c.action == "LINK_DOWN":
            self.link_down = True
            for r in self.roots.values():
                self._cancel(r)
                self._reset(r, f"IBKR {code}: {c.label}")
                if r.state not in ("NOT_ENTITLED", "UNRESOLVED"):
                    r.state = "OFFLINE"
        elif c.action == "RESET_ALL":
            self.link_down = False
            for r in self.roots.values():
                if r.contract is not None and r.state != "NOT_ENTITLED":
                    self._reset(r, f"IBKR {code}: {c.label}")
                    self._subscribe(r)
        elif c.action == "OFFLINE":
            self.detail = f"IBKR {code}: {message}"
        self._derive_state()

    def on_contract_details(self, req_id: int, details: dict) -> None:
        rk = self.by_req.get(req_id)
        if rk and rk[1] == "contract":
            self.roots[rk[0]].details.append(details)

    def on_contract_details_end(self, req_id: int) -> None:
        rk = self.by_req.pop(req_id, None)
        if not rk or rk[1] != "contract":
            return
        rs = self.roots[rk[0]]
        try:
            rs.contract = select_contract(rs.root, rs.target, rs.details)
        except Unresolved as e:
            rs.state, rs.detail, rs.contract = "UNRESOLVED", str(e), None
            log.error("%s", e)
            self._derive_state()
            return
        log.info("IBKR %s resolved: %s", rs.root, rs.contract.public())
        self.emit({"type": "contract", "root": rs.root, "contract": rs.contract.public()})
        self._subscribe(rs)
        self._derive_state()

    def on_depth(self, req_id: int, position: int, operation: int, side: int, price: float, size: float, market_maker: str = "") -> None:
        rk = self.by_req.get(req_id)
        if not rk or rk[1] != "depth":
            return  # a cancelled / foreign request: never applied
        rs = self.roots[rk[0]]
        now = self.clock()
        try:
            changes = rs.book.apply(int(position), int(operation), int(side), float(price), float(size), market_maker or "")
        except BookInconsistent as e:
            log.warning("%s book inconsistent (%s) - reset + resubscribe", rs.root, e)
            self._reset(rs, f"book inconsistent: {e}")
            self._subscribe(rs)
            return
        rs.updates += 1
        rs.ops[OPS[int(operation)]] += 1
        rs.market_makers_seen |= bool(market_maker)
        rs.last_depth_s = now
        if rs.state in ("SUBSCRIBING", "STALE"):
            rs.state, rs.detail = "LIVE", None
            self._derive_state()
        recv = self._ms(now)
        for side_name, p, s in changes:
            rs.seq += 1
            rs.pending.append([rs.seq, side_name, p, s, OPS[int(operation)], int(position), recv])

    # ------------------------------------------------------------------ gateway link events
    def on_targets(self, targets: dict) -> None:
        for root, local in targets.items():
            rs = self.roots.get(root)
            if not rs or not isinstance(local, str) or not local or local == rs.target:
                continue
            log.info("%s target contract %s -> %s", root, rs.target, local)
            self._cancel(rs)
            if rs.target is not None:
                self._reset(rs, f"contract change {rs.target} -> {local}")  # never mix contracts across a roll
            rs.target, rs.contract = local, None
            self._resolve(rs)
        self._derive_state()

    def snapshot(self, root: str) -> dict | None:
        rs = self.roots.get(root)
        if not rs:
            return None
        self.flush()
        live = rs.state == "LIVE"
        return {"type": "book", "root": root, "depthSeq": rs.seq, "valid": live, "contract": rs.contract.public() if rs.contract else None,
                "recvMs": self._ms(self.clock()), **(rs.book.snapshot() if live else {"bids": [], "asks": []})}

    # ------------------------------------------------------------------ periodic
    def flush(self) -> None:
        for rs in self.roots.values():
            while rs.pending:
                batch, rs.pending = rs.pending[:FLUSH_MAX], rs.pending[FLUSH_MAX:]
                self.emit({"type": "depth", "root": rs.root, "changes": batch})

    def tick(self) -> None:
        now = self.clock()
        for rs in self.roots.values():
            if rs.state == "LIVE" and rs.last_depth_s is not None and now - rs.last_depth_s > STALE_AFTER_S:
                self._reset(rs, f"no depth update for {int(STALE_AFTER_S)} s")
                rs.state, rs.detail = "STALE", f"no IBKR depth update for {int(STALE_AFTER_S)} s (market closed or feed silent)"
            if rs.state in ("STALE", "SUBSCRIBING") and rs.contract and self.connected and not self.link_down:
                since = rs.last_resubscribe_s or rs.subscribed_at_s or 0
                if now - since > RESUBSCRIBE_MIN_S:
                    rs.last_resubscribe_s = now
                    self._subscribe(rs)  # a fresh subscription re-sends the whole book as INSERT rows
                    if rs.state == "SUBSCRIBING":
                        rs.state = "STALE"
        self._derive_state()

    def health(self) -> dict:
        return {
            "session": {"state": self.state, "apiConnected": self.connected, "ibServerLink": not self.link_down if self.connected else None,
                        "authRequired": self.state == "AUTH_REQUIRED", "detail": self.detail, "serverVersion": self.server_version,
                        "lastIbHeartbeatMs": self._ms(self.last_ib_heartbeat_s), "lastConnectedMs": self._ms(self.last_connected_s),
                        "reconnects": self.reconnects, "nextReconnectMs": self._ms(self.next_reconnect_s), "lastError": self.last_error},
            "roots": {r.root: {"state": r.state, "detail": r.detail, "target": r.target, "contract": r.contract.public() if r.contract else None,
                               "rowsRequested": self.rows, "bidLevels": len(r.book.bids), "askLevels": len(r.book.asks),
                               "lastDepthMs": self._ms(r.last_depth_s), "updates": r.updates, "resets": r.resets, "ops": dict(r.ops),
                               "marketMakerField": r.market_makers_seen, "depthSeq": r.seq, "duplicatePrices": r.book.duplicate_prices,
                               "depthType": "MBP (aggregated price levels, IBKR reqMktDepth, isSmartDepth=false)", "timestampSource": "VPS receive time"}
                      for r in self.roots.values()},
        }
