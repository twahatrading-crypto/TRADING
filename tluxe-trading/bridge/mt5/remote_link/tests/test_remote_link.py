"""MT5 remote link: config safety, read-only enforcement, sequencing, reconnect, auth back-off and an END-TO-END run
through the REAL cloud gateway. TEST DATA ONLY: the "local MT5 bridge" is a tiny HTTP stand-in; no MT5, no network.
Needs the gateway package (cloud/gateway) and aiohttp on the path (see README)."""
import asyncio
import hashlib
import json
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[2] / "cloud" / "gateway"))

import link as L  # noqa: E402

LOCAL_TOKEN = "local-bridge-token-" + "l" * 32
REMOTE_TOKEN = "remote-link-token-" + "r" * 32


class FakeLocalBridge:
    """TEST DATA stand-in for the local TLUXE MT5 bridge on 127.0.0.1."""

    def __init__(self) -> None:
        self.seen: list[tuple[str, str]] = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):  # noqa: N802
                outer.seen.append((self.path, self.headers.get("Authorization", "")))
                if self.headers.get("Authorization") != f"Bearer {LOCAL_TOKEN}":
                    return self._send(401, {"error": {"code": "UNAUTHORIZED"}})
                if self.path == "/v1/health":
                    return self._send(200, {"bridge": {"version": "t"}, "terminal": {"state": "CONNECTED"}, "error": None})
                if self.path.startswith("/v1/quote/"):
                    return self._send(200, {"symbol": "XAUUSD", "bid": 2400.1, "ask": 2400.3, "timeUtcMs": int(time.time() * 1000), "sourceTimeMs": 1})
                return self._send(404, {"error": {"code": "NOT_FOUND"}})

            def _send(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def close(self) -> None:
        self.srv.shutdown()
        self.srv.server_close()


def env(**over):
    return {"TLUXE_GATEWAY_BRIDGE_URL": "wss://tluxe.example.app/bridge/mt5", "TLUXE_MT5_BRIDGE_TOKEN": REMOTE_TOKEN, "TLUXE_BRIDGE_TOKEN": LOCAL_TOKEN, **over}


class TestConfig(unittest.TestCase):
    def test_tls_loopback_and_token_rules(self):
        c = L.from_env(env())
        self.assertEqual(c.local_url, "http://127.0.0.1:8765")
        self.assertNotIn(REMOTE_TOKEN, repr(c))
        for bad in ({"TLUXE_GATEWAY_BRIDGE_URL": "ws://tluxe.example.app/bridge/mt5"}, {"TLUXE_GATEWAY_BRIDGE_URL": "https://tluxe.example.app/bridge/mt5"},
                    {"TLUXE_GATEWAY_BRIDGE_URL": "wss://tluxe.example.app/api/other"}, {"TLUXE_MT5_BRIDGE_TOKEN": "short"},
                    {"TLUXE_MT5_BRIDGE_TOKEN": LOCAL_TOKEN}, {"TLUXE_BRIDGE_TOKEN": ""}, {"TLUXE_LOCAL_BRIDGE_URL": "http://10.0.0.5:8765"},
                    {"TLUXE_LOCAL_BRIDGE_URL": "http://mt5.example.com:8765"}):
            with self.assertRaises(L.LinkConfigError, msg=str(bad)):
                L.from_env(env(**bad))
        self.assertTrue(L.from_env(env(TLUXE_GATEWAY_BRIDGE_URL="ws://127.0.0.1:9/bridge/mt5", TLUXE_LINK_ALLOW_INSECURE_LOCAL="1")))


class FakeWs:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, s: str) -> None:
        self.sent.append(json.loads(s))


class TestLinkUnit(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.local_calls: list[str] = []

        def local(cfg, path):
            self.local_calls.append(path)
            return 200, {"ok": True}

        self.link = L.Link(L.from_env(env()), local=local)

    def req(self, seq, **kw):
        return json.dumps({"type": "request", "id": seq, "method": "GET", "path": "/v1/health", "seq": seq, "ts": int(time.time() * 1000), **kw})

    async def test_read_only_refusals_never_touch_mt5(self):
        ws = FakeWs()
        for i, (method, path) in enumerate([("POST", "/v1/quote/XAUUSD"), ("GET", "/v1/order_send"), ("GET", "/v1/trade/close"), ("DELETE", "/v1/health"),
                                            ("GET", "/../../etc/passwd"), ("GET", "/v1/rates/XAUUSD;rm")], start=1):
            await self.link.handle(ws, self.req(i, method=method, path=path))
        self.assertEqual(self.local_calls, [])
        self.assertTrue(all(m["status"] == 403 for m in ws.sent))
        await self.link.handle(ws, self.req(10, path="/v1/rates/XAUUSD?timeframe=M1&count=500"))
        self.assertEqual(self.local_calls, ["/v1/rates/XAUUSD?timeframe=M1&count=500"])

    async def test_sequence_and_timestamp_validation(self):
        ws = FakeWs()
        await self.link.handle(ws, self.req(5))
        await self.link.handle(ws, self.req(5))  # replay
        await self.link.handle(ws, self.req(4))  # out of order
        await self.link.handle(ws, json.dumps({"type": "request", "id": 9, "method": "GET", "path": "/v1/health", "seq": 9, "ts": int(time.time() * 1000) - 120_000}))
        self.assertEqual(len(self.local_calls), 1)
        self.assertEqual(self.link.counts["rejected"], 3)
        seqs = [m["seq"] for m in ws.sent]
        self.assertEqual(seqs, sorted(set(seqs)))

    async def test_auth_failure_backs_off_no_tight_loop(self):
        class Rejected(Exception):
            response = type("R", (), {"status_code": 401})()

        async def connect(url, headers):
            raise Rejected()

        sleeps = []

        async def sleep(s):
            sleeps.append(s)
            if len(sleeps) >= 2:
                link.stopped.set()

        link = L.Link(L.from_env(env()), connect=connect, sleep=sleep)
        await asyncio.wait_for(link.run(), 5)
        self.assertEqual(sleeps, [L.AUTH_BACKOFF_S, L.AUTH_BACKOFF_S])
        self.assertEqual(link.counts["authFailures"], 2)


class TestEndToEnd(unittest.IsolatedAsyncioTestCase):
    """Browser -> REAL gateway -> REAL link (outbound WS) -> fake local MT5 bridge."""

    async def asyncSetUp(self) -> None:
        from aiohttp.test_utils import TestClient, TestServer
        from tluxe_gateway.app import K_RELAY, make_app
        from tluxe_gateway.auth import COOKIE, hash_password
        from tluxe_gateway.config import from_env as gw_env

        self.COOKIE = COOKIE
        self.local = FakeLocalBridge()
        self.cfg = gw_env({"TLUXE_ENV": "development", "TLUXE_OWNER_PASSWORD_HASH": hash_password("owner-password-123456", n=2**12),
                           "TLUXE_MT5_BRIDGE_TOKEN_SHA256": hashlib.sha256(REMOTE_TOKEN.encode()).hexdigest()})
        self.app = make_app(self.cfg, workers=False)
        self.K_RELAY = K_RELAY
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        r = await self.client.post("/api/auth/login", json={"password": "owner-password-123456"}, headers={"Origin": "http://localhost:5182"})
        self.sid = r.cookies[COOKIE].value
        self.h = {"Cookie": f"{COOKIE}={self.sid}", "Origin": "http://localhost:5182"}
        self.link_cfg = L.from_env(env(TLUXE_GATEWAY_BRIDGE_URL=f"ws://127.0.0.1:{self.client.port}/bridge/mt5", TLUXE_LINK_ALLOW_INSECURE_LOCAL="1",
                                       TLUXE_LOCAL_BRIDGE_URL=self.local.url, TLUXE_BRIDGE_ID="vps-e2e"))
        self.link = L.Link(self.link_cfg)
        self.task = asyncio.create_task(self.link.run())
        for _ in range(100):
            if self.app[K_RELAY].status()["connected"]:
                break
            await asyncio.sleep(0.05)

    async def asyncTearDown(self) -> None:
        self.link.stopped.set()
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)
        await self.client.close()
        self.local.close()

    async def test_quote_relayed_read_only_and_tokens_isolated(self):
        relay = self.app[self.K_RELAY]
        self.assertTrue(relay.status()["connected"])
        self.assertEqual(relay.status()["bridgeId"], "vps-e2e")
        r = await self.client.get("/api/mt5/v1/quote/XAUUSD", headers=self.h)
        body = await r.json()
        self.assertEqual((r.status, body["bid"], body["ask"]), (200, 2400.1, 2400.3))
        self.assertIsNotNone(relay.last_quote_ms)
        # The local token was used only between the link and the local bridge on the VPS.
        self.assertTrue(all(auth == f"Bearer {LOCAL_TOKEN}" for _, auth in self.local.seen))
        self.assertNotIn(LOCAL_TOKEN, json.dumps(body))
        # Read-only end to end.
        self.assertEqual((await self.client.post("/api/mt5/v1/quote/XAUUSD", headers=self.h)).status, 405)
        self.assertEqual((await self.client.get("/api/mt5/v1/order_send", headers=self.h)).status, 403)
        self.assertFalse(any("order" in p for p, _ in self.local.seen))
        # Heartbeat carries the terminal state for health.
        for _ in range(60):
            if relay.terminal():
                break
            await asyncio.sleep(0.05)
        self.assertEqual(relay.terminal()["terminal"]["state"], "CONNECTED")

    async def test_reconnects_after_the_connection_drops(self):
        relay = self.app[self.K_RELAY]
        self.link._sleep = lambda s: asyncio.sleep(0.05)  # fast back-off for the test
        await relay.ws.close()
        for _ in range(200):
            if self.link.counts["connects"] >= 2 and relay.status()["connected"]:
                break
            await asyncio.sleep(0.05)
        self.assertGreaterEqual(self.link.counts["connects"], 2)
        r = await self.client.get("/api/mt5/v1/health", headers=self.h)
        self.assertEqual(r.status, 200)

    async def test_wrong_remote_token_is_rejected(self):
        bad = L.Link(L.from_env(env(TLUXE_GATEWAY_BRIDGE_URL=f"ws://127.0.0.1:{self.client.port}/bridge/mt5", TLUXE_LINK_ALLOW_INSECURE_LOCAL="1",
                                    TLUXE_MT5_BRIDGE_TOKEN="w" * 40, TLUXE_LOCAL_BRIDGE_URL=self.local.url)))
        self.assertEqual(await bad.session(), "auth")
        self.assertEqual(self.app[self.K_RELAY].counts["authRejected"], 1)


if __name__ == "__main__":
    unittest.main()
