"""Browser real-time transport (/api/stream, WSS in production).

One authenticated WebSocket per browser tab replaces aggressive polling:
  status           unified component status (on change + every 30 s)
  databento        Databento frames / health pushed by the gateway (only while a client subscribes)
  news             sequence numbers of new / revised news items (the client then fetches only the changes)
  heartbeat        every 15 s - the client detects a stale transport and reconnects with back-off

Every message carries a per-connection strictly increasing `seq` and the server time `ts` so the client can detect
gaps (and resync) and staleness. Each client has a bounded queue; a client that cannot keep up is disconnected
(it reconnects and resyncs) instead of growing memory.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time

log = logging.getLogger("tluxe.gateway.stream")
CHANNELS = ("status", "databento", "news")
QUEUE_MAX = 256
HEARTBEAT_S = 15


class Client:
    def __init__(self, ws) -> None:
        self.ws = ws
        self.seq = 0
        self.channels: set[str] = {"status", "news"}
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
        self.dropped = False


class StreamHub:
    def __init__(self, clock=time.time) -> None:
        self.clients: set[Client] = set()
        self.clock = clock
        self.last: dict[str, dict] = {}
        self.sent = 0
        self.slow_disconnects = 0

    def subscribers(self, channel: str) -> int:
        return sum(1 for c in self.clients if channel in c.channels)

    def publish(self, channel: str, data: dict, *, remember: bool = False) -> None:
        if remember:
            self.last[channel] = data
        for c in list(self.clients):
            if channel not in c.channels or c.dropped:
                continue
            try:
                c.queue.put_nowait((channel, data))
            except asyncio.QueueFull:
                c.dropped = True
                self.slow_disconnects += 1

    async def _writer(self, c: Client) -> None:
        while True:
            channel, data = await c.queue.get()
            if c.dropped:
                await c.ws.close(code=1013, message=b"client too slow - reconnect")
                return
            c.seq += 1
            await c.ws.send_str(json.dumps({"type": channel, "seq": c.seq, "ts": int(self.clock() * 1000), "data": data}, separators=(",", ":")))
            self.sent += 1

    async def serve(self, ws) -> None:
        """Run one authenticated connection until it closes."""
        c = Client(ws)
        self.clients.add(c)
        writer = asyncio.create_task(self._writer(c))
        hb = asyncio.create_task(self._heartbeats(c))
        try:
            c.queue.put_nowait(("hello", {"channels": sorted(c.channels), "heartbeatS": HEARTBEAT_S}))
            for ch in ("status",):
                if ch in self.last:
                    c.queue.put_nowait((ch, self.last[ch]))
            async for msg in ws:
                if msg.type != 1:  # aiohttp WSMsgType.TEXT
                    break
                try:
                    m = json.loads(msg.data)
                except ValueError:
                    continue
                if isinstance(m, dict) and m.get("type") in ("subscribe", "unsubscribe") and isinstance(m.get("channels"), list):
                    chans = {x for x in m["channels"] if x in CHANNELS}
                    c.channels = c.channels | chans if m["type"] == "subscribe" else c.channels - chans
                    if m["type"] == "subscribe" and "databento" in chans and "databento-health" in self.last:
                        c.queue.put_nowait(("databento", self.last["databento-health"]))
        finally:
            self.clients.discard(c)
            writer.cancel()
            hb.cancel()

    async def _heartbeats(self, c: Client) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_S)
            try:
                c.queue.put_nowait(("heartbeat", {}))
            except asyncio.QueueFull:
                c.dropped = True

    async def close_all(self) -> None:
        for c in list(self.clients):
            try:
                await c.ws.close(code=1001, message=b"server shutting down")
            except Exception:
                pass
