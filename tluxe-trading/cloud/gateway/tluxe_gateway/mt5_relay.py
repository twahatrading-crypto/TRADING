"""Remote MT5 bridge relay (MARKET DATA ONLY - no trading, no order routes exist at any layer).

  Windows VPS: MT5 terminal -> local TLUXE MT5 bridge (127.0.0.1:8765) -> remote link (bridge/mt5/remote_link)
     -- OUTBOUND wss -->  gateway /bridge/mt5  (this module)  <-- browser GET /api/mt5/v1/... (owner session)

The VPS never accepts inbound connections. Security:
  * the link authenticates with a bridge token; the cloud stores only SHA-256 hashes (TLUXE_MT5_BRIDGE_TOKEN_SHA256,
    several allowed at once with optional expiry -> rotation without downtime);
  * every message carries a strictly increasing `seq` and a timestamp; out-of-order / replayed / skewed (> 30 s)
    messages are rejected and recorded as integrity events; sequence gaps are recorded;
  * heartbeats both ways; no message for STALE_AFTER_S -> the link is STALE and closed (the VPS reconnects);
  * only read-only GET paths on an explicit allowlist are relayed (checked here AND on the VPS link).
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import itertools
import json
import logging
import re
import time
from typing import Awaitable, Callable

from .config import Mt5BridgeKey

log = logging.getLogger("tluxe.gateway.mt5")
READ_ONLY_PATH = re.compile(r"^/v1/(health|symbols|symbol/[A-Za-z0-9._#%-]{1,64}|quote/[A-Za-z0-9._#%-]{1,64}|rates/[A-Za-z0-9._#%-]{1,64})(\?[A-Za-z0-9_=&.%-]{0,200})?$")
MAX_SKEW_MS = 30_000
STALE_AFTER_S = 30
HEARTBEAT_S = 10
REQUEST_TIMEOUT_S = 15
MAX_MESSAGE = 4_000_000


def read_only_path(path: str) -> bool:
    return bool(READ_ONLY_PATH.match(path))


def token_ok(token: str, keys: tuple[Mt5BridgeKey, ...], now_s: float | None = None) -> bool:
    if not token or not keys:
        return False
    digest = hashlib.sha256(token.encode()).hexdigest()
    now = time.time() if now_s is None else now_s
    ok = False
    for k in keys:  # constant-time over every configured key
        match = hmac.compare_digest(digest, k.sha256)
        ok |= match and (k.expires_at is None or k.expires_at > now)
    return ok


class RelayError(Exception):
    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


class Mt5Relay:
    def __init__(self, keys: tuple[Mt5BridgeKey, ...], on_integrity: Callable[[str, dict], Awaitable[None]] | None = None,
                 clock: Callable[[], float] = time.time) -> None:
        self.keys = keys
        self.clock = clock
        self.on_integrity = on_integrity
        self.ws = None
        self.bridge_id: str | None = None
        self.connected_at: float | None = None
        self.last_rx: float | None = None
        self.rx_seq = 0
        self.tx_seq = itertools.count(1)
        self.pending: dict[int, asyncio.Future] = {}
        self.ids = itertools.count(1)
        self.terminal_health: dict | None = None
        self.last_quote_ms: int | None = None
        self.counts = {"rejectedSkew": 0, "rejectedReplay": 0, "gaps": 0, "requests": 0, "blockedPaths": 0, "authRejected": 0}
        self.last_detail: str | None = None

    def now_ms(self) -> int:
        return int(self.clock() * 1000)

    def status(self) -> dict:
        stale = self.ws is not None and self.last_rx is not None and self.clock() - self.last_rx > STALE_AFTER_S
        return {"connected": self.ws is not None, "stale": stale, "bridgeId": self.bridge_id, "connectedAtMs": int(self.connected_at * 1000) if self.connected_at else None,
                "lastMessageMs": int(self.last_rx * 1000) if self.last_rx else None, "detail": self.last_detail, "counts": dict(self.counts)}

    def terminal(self) -> dict | None:
        if self.terminal_health is None:
            return None
        return {**self.terminal_health, "lastQuoteMs": self.last_quote_ms}

    async def _integrity(self, kind: str, detail: dict) -> None:
        if self.on_integrity:
            try:
                await self.on_integrity(kind, detail)
            except Exception:  # pragma: no cover - never break the link over bookkeeping
                log.exception("integrity event not stored")

    def validate(self, msg: dict) -> str | None:
        """Returns a rejection reason or None. Updates the receive sequence."""
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
            self.counts["gaps"] += 1
            self.last_detail = f"sequence gap {self.rx_seq} -> {seq}"
        self.rx_seq = seq
        return None

    def envelope(self, body: dict) -> dict:
        return {**body, "seq": next(self.tx_seq), "ts": self.now_ms()}

    # -------------------------------------------------------------- link side (aiohttp WebSocketResponse)
    async def attach(self, ws, bridge_id: str) -> None:
        if self.ws is not None:
            log.warning("MT5 bridge link %s replaces the previous link %s", bridge_id, self.bridge_id)
            try:
                await self.ws.close(code=4000, message=b"replaced")
            except Exception:
                pass
            self._fail_pending("MT5 bridge link replaced.")
        self.ws, self.bridge_id = ws, bridge_id[:64]
        self.connected_at = self.last_rx = self.clock()
        self.rx_seq = 0
        self.tx_seq = itertools.count(1)
        self.last_detail = None

    def detach(self, ws, why: str) -> None:
        if self.ws is ws:
            self.ws = None
            self.last_detail = why
            self._fail_pending(f"MT5 bridge link closed ({why}).")

    def _fail_pending(self, why: str) -> None:
        for fut in self.pending.values():
            if not fut.done():
                fut.set_exception(RelayError("BRIDGE_OFFLINE", why, 503))
        self.pending.clear()

    async def on_message(self, raw: str) -> None:
        if len(raw) > MAX_MESSAGE:
            await self._integrity("REJECTED", {"reason": "MESSAGE_TOO_LARGE"})
            return
        try:
            msg = json.loads(raw)
        except ValueError:
            await self._integrity("REJECTED", {"reason": "NOT_JSON"})
            return
        if not isinstance(msg, dict):
            return
        why = self.validate(msg)
        if why:
            await self._integrity("REJECTED" if why != "MALFORMED" else "MALFORMED", {"reason": why, "type": str(msg.get("type"))[:20]})
            return
        self.last_rx = self.clock()
        kind = msg.get("type")
        if kind == "heartbeat":
            h = msg.get("health")
            if isinstance(h, dict):
                self.terminal_health = {"terminal": h.get("terminal") or {}, "error": h.get("error"), "bridge": h.get("bridge") or {}}
        elif kind == "response":
            fut = self.pending.pop(msg.get("id"), None)
            if fut and not fut.done():
                fut.set_result(msg)

    async def heartbeat(self) -> None:
        """Send a heartbeat; close a stale link (the VPS link reconnects on its own)."""
        ws = self.ws
        if ws is None:
            return
        if self.last_rx is not None and self.clock() - self.last_rx > STALE_AFTER_S:
            log.warning("MT5 bridge link stale (no message for %d s) - closing", STALE_AFTER_S)
            await self._integrity("STALE", {"bridgeId": self.bridge_id})
            await ws.close(code=4001, message=b"stale")
            self.detach(ws, "stale")
            return
        await ws.send_str(json.dumps(self.envelope({"type": "heartbeat"})))

    # -------------------------------------------------------------- browser side
    async def request(self, path: str, timeout: float = REQUEST_TIMEOUT_S) -> tuple[int, object]:
        if not read_only_path(path):
            self.counts["blockedPaths"] += 1
            raise RelayError("FORBIDDEN_PATH", "Only read-only MT5 market-data requests are relayed.", 403)
        ws = self.ws
        if ws is None:
            raise RelayError("BRIDGE_OFFLINE", "MT5 bridge link (Windows VPS) is not connected.", 503)
        rid = next(self.ids)
        fut = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        self.counts["requests"] += 1
        await ws.send_str(json.dumps(self.envelope({"type": "request", "id": rid, "method": "GET", "path": path})))
        try:
            msg = await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            self.pending.pop(rid, None)
            raise RelayError("BRIDGE_TIMEOUT", "MT5 bridge did not answer in time.", 504) from None
        status = int(msg.get("status") or 502)
        body = msg.get("body")
        if status == 200 and path.startswith("/v1/quote/") and isinstance(body, dict):
            t = body.get("timeUtcMs") or body.get("sourceTimeMs")
            if isinstance(t, (int, float)):
                self.last_quote_ms = max(self.last_quote_ms or 0, int(t))
        return status, body
