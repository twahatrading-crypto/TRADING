"""HLR data relay: read-only, owner-only, pass-through, and absent unless configured.

The dangerous paths here are real: the HLR bridge on the trading PC can place orders and send e-mail.
These tests exist to prove those paths can never be reached through the relay, that the relay never
invents or caches data, and that nothing exists at all when no credential is configured.

TEST DATA ONLY. A stand-in link plays the part of the Windows PC; nothing contacts MT5, IBKR, the
outcome tracker or the network.
"""
import asyncio
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from aiohttp import WSMsgType, web
from aiohttp.test_utils import TestClient, TestServer

from tluxe_gateway.app import make_app
from tluxe_gateway.auth import hash_password
from tluxe_gateway.config import from_env
from tluxe_gateway.hlr_relay import allowed_path
from tluxe_gateway.store import MemoryStore

PASSWORD = "correct horse battery staple 42"
PW_HASH = hash_password(PASSWORD, n=2**12)
TOKEN = "hlr-link-token-" + "z" * 40
TOKEN_SHA = hashlib.sha256(TOKEN.encode()).hexdigest()
ORIGIN = "http://localhost:5182"

#: A GC snapshot shaped like the real engine's, including the fields hlr-gc.js reads.
SNAPSHOT = {"market_status": "LIVE", "connected": True, "last_trade_price": 4013.5,
            "previous_close": 4008.1, "analysis_enabled": True, "gates": [],
            "result": {"bias": "BUY", "entry": 4011.0, "sl": 4004.0, "tp": 4025.0}}


def env(**over):
    # The relay is gated by the HLR page credential, not the owner login (which stays unset).
    return {"TLUXE_ENV": "development", "TLUXE_HLR_PASSWORD_HASH": PW_HASH, **over}


class FakeLink:
    """Stands in for bridge/hlr-link on the trading PC."""

    def __init__(self) -> None:
        self.seen: list[tuple[str, str]] = []
        self.task = None

    async def run(self, client, token=TOKEN):
        ws = await client.ws_connect("/bridge/hlr", headers={"Authorization": f"Bearer {token}",
                                                             "X-TLUXE-Bridge-Id": "test-pc"})
        self.ws = ws
        self.task = asyncio.create_task(self._loop(ws))
        return ws

    async def _loop(self, ws):
        seq = 0
        async for msg in ws:
            if msg.type is not WSMsgType.TEXT:
                break
            m = json.loads(msg.data)
            if m.get("type") != "request":
                continue
            self.seen.append((m.get("upstream"), m.get("path")))
            seq += 1
            body = SNAPSHOT if m.get("upstream") == "gc" else {"ok": True, "echo": m.get("path")}
            await ws.send_str(json.dumps({"type": "response", "id": m["id"], "status": 200,
                                          "body": body, "seq": seq, "ts": int(asyncio.get_running_loop().time() * 0) + _now_ms()}))

    async def stop(self):
        if self.task:
            self.task.cancel()
        await self.ws.close()


def _now_ms() -> int:
    import time
    return int(time.time() * 1000)


class TestAllowlist(unittest.TestCase):
    """The allowlist is the safety property; exercise it directly, not only over HTTP."""

    def test_read_only_paths_are_allowed(self):
        for up, path in (("mt5", "/api/status"), ("mt5", "/api/history?symbol=XAUUSD&tf=M15"),
                         ("mt5", "/api/signal-log"), ("mt5", "/api/alert-status"),
                         ("gc", "/api/snapshot"), ("tracker", "/api/outcomes"),
                         ("tracker", "/api/history?limit=50")):
            self.assertTrue(allowed_path(up, path), f"{up}{path}")

    def test_order_and_email_paths_can_never_be_relayed(self):
        for up in ("mt5", "gc", "tracker"):
            for path in ("/api/order", "/api/trade", "/api/position", "/api/account/info",
                         "/api/alert-email", "/api/alert-test-email"):
                self.assertFalse(allowed_path(up, path), f"{up}{path}")

    def test_upstreams_cannot_be_crossed_or_invented(self):
        self.assertFalse(allowed_path("gc", "/api/status"))        # GC serves only its snapshot
        self.assertFalse(allowed_path("tracker", "/api/snapshot"))
        self.assertFalse(allowed_path("databento", "/api/snapshot"))  # never a GC substitute
        self.assertFalse(allowed_path("", "/api/status"))

    def test_path_tricks_are_refused(self):
        for path in ("/api/status/../order", "/api/../api/order", "/API/ORDER",
                     "/api/statusx", "/api/order?x=1", "//api/order"):
            self.assertFalse(allowed_path("mt5", path), path)


class TestRelayDisabled(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.cfg = from_env(env())  # no TLUXE_HLR_BRIDGE_TOKEN_SHA256
        self.client = TestClient(TestServer(make_app(self.cfg, store=MemoryStore(), workers=False)))
        await self.client.start_server()

    async def asyncTearDown(self) -> None:
        await self.client.close()

    async def test_no_relay_routes_exist_at_all(self):
        for path in ("/api/hlr/status", "/api/hlr/gc/api/snapshot", "/api/hlr/mt5/api/status", "/bridge/hlr"):
            self.assertEqual((await self.client.get(path)).status, 404, path)


class TestRelay(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name) / "web"
        root.mkdir()
        (root / "index.html").write_bytes(b"<!doctype html><title>TLUXE</title>")
        hlr = root.parent / "private" / "hlr-original"
        hlr.mkdir(parents=True, exist_ok=True)
        (hlr / "hlr.html").write_bytes(b"<!doctype html><title>HLR</title><script src=\"feed.js\"></script>\n")
        self.root = root
        self.cfg = from_env(env(TLUXE_HLR_BRIDGE_TOKEN_SHA256=TOKEN_SHA, TLUXE_STATIC_DIR=str(root), TLUXE_HLR_FILES_DIR=str(root.parent / "private" / "hlr-original")))
        self.client = TestClient(TestServer(make_app(self.cfg, store=MemoryStore(), workers=False)))
        await self.client.start_server()
        self.link = FakeLink()

    async def asyncTearDown(self) -> None:
        await self.client.close()
        self.tmp.cleanup()

    async def login(self):
        r = await self.client.post("/api/hlr/auth/login", json={"password": PASSWORD}, headers={"Origin": ORIGIN})
        self.assertEqual(r.status, 200, await r.text())

    # ------------------------------------------------------------------ auth

    async def test_link_needs_a_valid_credential(self):
        with self.assertRaises(Exception):
            await self.client.ws_connect("/bridge/hlr", headers={"Authorization": "Bearer wrong-token"})

    async def test_browser_needs_an_owner_session(self):
        await self.link.run(self.client)
        r = await self.client.get("/api/hlr/gc/api/snapshot")
        self.assertEqual(r.status, 401)
        self.assertNotIn(b"4013.5", await r.read())  # no market data without a session
        await self.link.stop()

    # ------------------------------------------------------------- behaviour

    async def test_gc_analysis_passes_through_unchanged(self):
        await self.login()
        await self.link.run(self.client)
        r = await self.client.get("/api/hlr/gc/api/snapshot")
        self.assertEqual(r.status, 200)
        self.assertEqual(await r.json(), SNAPSHOT)      # byte-equal object: nothing reshaped
        self.assertEqual(self.link.seen[-1], ("gc", "/api/snapshot"))
        await self.link.stop()

    async def test_query_strings_reach_the_pc_intact(self):
        await self.login()
        await self.link.run(self.client)
        await self.client.get("/api/hlr/mt5/api/history?symbol=XAUUSD&tf=M15&count=300")
        self.assertEqual(self.link.seen[-1], ("mt5", "/api/history?symbol=XAUUSD&tf=M15&count=300"))
        await self.link.stop()

    async def test_order_and_email_paths_are_refused_before_reaching_the_pc(self):
        await self.login()
        await self.link.run(self.client)
        for path in ("/api/hlr/mt5/api/order", "/api/hlr/mt5/api/trade",
                     "/api/hlr/mt5/api/alert-email", "/api/hlr/mt5/api/alert-test-email"):
            r = await self.client.get(path)
            self.assertEqual(r.status, 403, path)
        self.assertEqual(self.link.seen, [], "a forbidden path reached the trading PC")
        await self.link.stop()

    async def test_non_get_is_refused(self):
        await self.login()
        await self.link.run(self.client)
        r = await self.client.post("/api/hlr/mt5/api/status", headers={"Origin": ORIGIN})
        self.assertEqual(r.status, 405)
        await self.link.stop()

    async def test_offline_link_errors_instead_of_serving_a_stale_body(self):
        """A cached snapshot saying market_status LIVE would be a lie. There is no cache."""
        await self.login()
        await self.link.run(self.client)
        self.assertEqual((await self.client.get("/api/hlr/gc/api/snapshot")).status, 200)
        await self.link.stop()
        await asyncio.sleep(0.1)
        r = await self.client.get("/api/hlr/gc/api/snapshot")
        self.assertEqual(r.status, 503)
        body = await r.text()
        self.assertNotIn("4013.5", body)
        self.assertNotIn("LIVE", body)

    async def test_status_route_reports_the_link_not_market_data(self):
        await self.login()
        r = await self.client.get("/api/hlr/status")
        self.assertEqual(r.status, 200)
        b = await r.json()
        self.assertIn("link", b)
        self.assertFalse(b["link"]["connected"])
        self.assertNotIn("4013.5", json.dumps(b))

    # ------------------------------------------------------------------ shim

    async def test_shim_is_served_and_injected_only_when_the_relay_exists(self):
        await self.login()
        r = await self.client.get("/hlr-original/_tluxe-shim.js")
        self.assertEqual(r.status, 200)
        js = await r.text()
        self.assertIn("/api/hlr", js)
        doc = await (await self.client.get("/hlr-original/hlr.html")).text()
        self.assertIn('<script src="_tluxe-shim.js">', doc)
        # ...and the original markup is still all there, in order.
        self.assertIn('<script src="feed.js">', doc)
        self.assertLess(doc.index("_tluxe-shim.js"), doc.index("feed.js"))

    async def test_shim_needs_a_session_too(self):
        r = await self.client.get("/hlr-original/_tluxe-shim.js")
        self.assertEqual(r.status, 401)


if __name__ == "__main__":
    unittest.main()
