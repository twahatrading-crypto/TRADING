"""Outbound secure link: VPS bridge -> TLUXE cloud gateway (/bridge/ibkr). The VPS never accepts inbound connections.

  * authenticated with TLUXE_IBKR_BRIDGE_TOKEN (the cloud stores only its SHA-256);
  * every message carries a strictly increasing `seq` and a `ts`; replayed / out-of-order / skewed gateway
    messages are ignored;
  * heartbeat every 10 s; no gateway message for 45 s = stale -> reconnect; jittered back-off 2 s -> 60 s;
    a rejected credential backs off 5 minutes (never hammer the gateway).
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from typing import Awaitable, Callable

log = logging.getLogger("tluxe.ibkr.link")
HEARTBEAT_S = 10
STALE_S = 45
MAX_SKEW_MS = 30_000
AUTH_BACKOFF_S = 300


class Envelope:
    """Numbers outbound messages; validates inbound ones."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self.clock = clock
        self.tx = 0
        self.rx = 0

    def wrap(self, body: dict) -> str:
        self.tx += 1
        return json.dumps({**body, "seq": self.tx, "ts": int(self.clock() * 1000)}, separators=(",", ":"))

    def accept(self, msg: dict) -> bool:
        seq, ts = msg.get("seq"), msg.get("ts")
        if not isinstance(seq, int) or not isinstance(ts, int):
            return False
        if abs(ts - int(self.clock() * 1000)) > MAX_SKEW_MS or seq <= self.rx:
            return False
        self.rx = seq
        return True


def backoff_s(attempt: int, rnd: Callable[[], float] = random.random) -> float:
    base = min(60.0, 2.0 * 2 ** max(0, attempt))
    return base * (0.5 + rnd() * 0.5)


class GatewayLink:
    def __init__(self, url: str, token, bridge_id: str, on_message: Callable[[dict], None],
                 on_connected: Callable[[], Awaitable[None]], connect=None) -> None:
        self.url, self.token, self.bridge_id = url, token, bridge_id
        self.on_message, self.on_connected = on_message, on_connected
        self._connect = connect  # injectable for tests
        self.ws = None
        self.env = Envelope()
        self.state = "CONNECTING"
        self.attempt = 0
        self.last_rx = 0.0
        self.dropped = 0

    def send(self, body: dict) -> None:
        """Fire-and-forget; messages while the link is down are dropped (the gateway gets a fresh snapshot on
        reconnect - depth is never replayed out of date)."""
        ws = self.ws
        if ws is None:
            self.dropped += 1
            return
        asyncio.get_running_loop().create_task(self._send(ws, self.env.wrap(body)))

    async def _send(self, ws, raw: str) -> None:
        try:
            await ws.send(raw)
        except Exception:
            self.dropped += 1

    async def run_forever(self) -> None:
        while True:
            wait = await self._run_once()
            await asyncio.sleep(wait)

    async def _run_once(self) -> float:
        import websockets  # installed from requirements.txt

        connect = self._connect or (lambda: websockets.connect(self.url, additional_headers={"Authorization": f"Bearer {self.token.reveal()}", "X-TLUXE-Bridge-Id": self.bridge_id},
                                                               max_size=4_000_000, ping_interval=None, open_timeout=15))
        try:
            async with connect() as ws:
                self.ws, self.env, self.state, self.attempt = ws, Envelope(), "LIVE", 0
                self.last_rx = time.time()
                log.info("link to TLUXE gateway established")
                self.send({"type": "hello", "bridgeId": self.bridge_id, "product": "tluxe-ibkr-depth", "readOnly": True})
                await self.on_connected()
                hb = asyncio.create_task(self._heartbeats(ws))
                try:
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except ValueError:
                            continue
                        if isinstance(msg, dict) and self.env.accept(msg):
                            self.last_rx = time.time()
                            if msg.get("type") != "heartbeat":
                                self.on_message(msg)
                finally:
                    hb.cancel()
        except Exception as e:  # noqa: BLE001 - every failure means: back off and retry
            status = getattr(getattr(e, "response", None), "status_code", None) or getattr(e, "status_code", None)
            if status in (401, 403):
                log.error("gateway rejected the IBKR bridge credential - retry in %d s", AUTH_BACKOFF_S)
                self._down("AUTH_REJECTED")
                return AUTH_BACKOFF_S
            log.warning("gateway link down: %s", type(e).__name__)
        self._down("RECONNECTING")
        self.attempt += 1
        return backoff_s(self.attempt)

    def _down(self, state: str) -> None:
        self.ws = None
        self.state = state

    async def _heartbeats(self, ws) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_S)
            if time.time() - self.last_rx > STALE_S:
                log.warning("gateway link stale (%d s silent) - reconnecting", STALE_S)
                await ws.close()
                return
            self.send({"type": "heartbeat"})
