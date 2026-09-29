"""TLUXE cloud gateway tests: production config, PostgreSQL migrations / persistence, owner auth, strict CORS,
WebSocket auth + stream, internal proxies (tokens stay server-side), unified health, MT5 remote relay (read-only),
log redaction. TEST DATA ONLY: stand-in internal services are small local aiohttp apps; no external network.

PostgreSQL: set TLUXE_TEST_DATABASE_URL (a server where the test may CREATE / DROP databases), e.g.
postgresql://tluxe@127.0.0.1:55432/postgres - database tests are skipped (not faked) when it is absent.
"""
import asyncio
import hashlib
import io
import json
import logging
import os
import time
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path

from aiohttp import WSMsgType, web
from aiohttp.test_utils import TestClient, TestServer

from tluxe_gateway import health as H
from tluxe_gateway.app import make_app, redactor_for
from tluxe_gateway.auth import COOKIE, GlobalFailLimiter, hash_password, hash_password_pbkdf2, verify_password
from tluxe_gateway.config import ConfigError, from_env
from tluxe_gateway.logs import Redactor, setup_logging
from tluxe_gateway.mt5_relay import read_only_path, token_ok
from tluxe_gateway.store import MemoryStore, PgStore, migration_files

PG_ADMIN = os.environ.get("TLUXE_TEST_DATABASE_URL", "")
PASSWORD = "correct horse battery staple 42"
PW_HASH = hash_password(PASSWORD, n=2**12)
AI_TOKEN, DB_TOKEN, NEWS_TOKEN = "a" * 40, "d" * 40, "n" * 40
BRIDGE_TOKEN = "mt5-bridge-token-" + "x" * 40
BRIDGE_SHA = hashlib.sha256(BRIDGE_TOKEN.encode()).hexdigest()
IBKR_TOKEN = "ibkr-bridge-token-" + "y" * 40
IBKR_SHA = hashlib.sha256(IBKR_TOKEN.encode()).hexdigest()
APP = "https://tluxe.example.app"


def prod_env(**over):
    return {"TLUXE_ENV": "production", "PUBLIC_APP_URL": APP, "ALLOWED_ORIGINS": APP, "DATABASE_URL": "postgresql://u:dbpass123@db.internal:5432/tluxe",
            "TLUXE_OWNER_PASSWORD_HASH": PW_HASH, **over}


def dev_env(**over):
    return {"TLUXE_ENV": "development", "TLUXE_OWNER_PASSWORD_HASH": PW_HASH, "TLUXE_MT5_BRIDGE_TOKEN_SHA256": BRIDGE_SHA, **over}


class TestConfig(unittest.TestCase):
    def test_production_fails_closed(self):
        self.assertEqual(from_env(prod_env()).allowed_origins, (APP,))
        for bad in ({"ALLOWED_ORIGINS": "*"}, {"ALLOWED_ORIGINS": "http://localhost:5182"}, {"ALLOWED_ORIGINS": "https://*.example.app"},
                    {"ALLOWED_ORIGINS": "http://tluxe.example.app"}, {"PUBLIC_APP_URL": "http://tluxe.example.app"}, {"PUBLIC_APP_URL": ""},
                    {"DATABASE_URL": ""}, {"TLUXE_OWNER_PASSWORD_HASH": "plaintextpassword"}):
            with self.assertRaises(ConfigError, msg=str(bad)):
                from_env(prod_env(**bad))

    def test_production_has_no_localhost_dependency(self):
        c = from_env(prod_env(TLUXE_AI_URL="http://tluxe-ai.railway.internal:8767", TLUXE_AI_TOKEN=AI_TOKEN))
        self.assertEqual(c.host, "0.0.0.0")  # Railway public networking: 0.0.0.0 on $PORT
        self.assertTrue(c.cookie_secure)
        self.assertEqual(c.log_format, "json")
        for o in c.allowed_origins:
            self.assertNotIn("localhost", o)
            self.assertNotIn("127.0.0.1", o)

    def test_railway_crash_causes_are_handled(self):
        # Every missing required variable is reported in ONE message (one redeploy fixes them all).
        with self.assertRaises(ConfigError) as cm:
            from_env({"TLUXE_ENV": "production", "PORT": "8080"})
        msg = str(cm.exception)
        for key in ("PUBLIC_APP_URL", "DATABASE_URL"):
            self.assertIn(key, msg)
        # Railway shows domains without a scheme; RAILWAY_PUBLIC_DOMAIN is a fallback.
        self.assertEqual(from_env(prod_env(PUBLIC_APP_URL="tluxe.example.app", ALLOWED_ORIGINS="tluxe.example.app")).allowed_origins, (APP,))
        env = prod_env()
        env.pop("PUBLIC_APP_URL")
        env.pop("ALLOWED_ORIGINS", None)
        self.assertEqual(from_env({**env, "RAILWAY_PUBLIC_DOMAIN": "tluxe.example.app"}).public_app_url, APP)
        # $PORT always wins in production and the gateway binds 0.0.0.0.
        c = from_env(prod_env(PORT="7123", TLUXE_GATEWAY_PORT="8780"))
        self.assertEqual((c.host, c.port), ("0.0.0.0", 7123))
        # A bare private hostname works; a broken optional upstream is reported, never fatal.
        self.assertEqual(from_env(prod_env(TLUXE_AI_URL="tluxe-ai.railway.internal:8080", TLUXE_AI_TOKEN=AI_TOKEN)).ai.url, "http://tluxe-ai.railway.internal:8080")
        bad = from_env(prod_env(TLUXE_AI_URL="http://${{tluxe-ai.RAILWAY_PRIVATE_DOMAIN}}", TLUXE_AI_TOKEN=AI_TOKEN)).ai
        self.assertFalse(bad.configured)
        self.assertIn("TLUXE_AI_URL", bad.problem)
        self.assertNotIn(AI_TOKEN, bad.problem)
        # No owner hash yet -> public READ-ONLY market-data mode (not an open gateway); a hash switches it off.
        self.assertTrue(from_env(prod_env(TLUXE_OWNER_PASSWORD_HASH="")).public_market_data)
        self.assertFalse(from_env(prod_env()).public_market_data)

    def test_development_keeps_localhost(self):
        c = from_env(dev_env())
        self.assertIn("http://localhost:5182", c.allowed_origins)
        self.assertIn("http://127.0.0.1:5182", c.allowed_origins)
        self.assertEqual((c.host, c.port), ("127.0.0.1", 8780))
        self.assertFalse(c.cookie_secure)
        with self.assertRaises(ConfigError):
            from_env(dev_env(ALLOWED_ORIGINS="*"))

    def test_secrets_never_in_repr(self):
        c = from_env(prod_env(TLUXE_AI_URL="http://ai:8767", TLUXE_AI_TOKEN=AI_TOKEN))
        r = repr(c)
        for s in (AI_TOKEN, "dbpass123", PW_HASH):
            self.assertNotIn(s, r)

    def test_mt5_keys_rotation_and_expiry(self):
        c = from_env(dev_env(TLUXE_MT5_BRIDGE_TOKEN_SHA256=f"{BRIDGE_SHA}@{int(time.time()) + 60},{hashlib.sha256(b'next-token-yyyyyyyyyyyyyyyyyyyyyyyyyyyyy').hexdigest()}"))
        self.assertTrue(token_ok(BRIDGE_TOKEN, c.mt5_bridge_keys))
        self.assertTrue(token_ok("next-token-yyyyyyyyyyyyyyyyyyyyyyyyyyyyy", c.mt5_bridge_keys))
        self.assertFalse(token_ok(BRIDGE_TOKEN, c.mt5_bridge_keys, now_s=time.time() + 3600))  # expired
        self.assertFalse(token_ok("wrong", c.mt5_bridge_keys))
        with self.assertRaises(ConfigError):
            from_env(dev_env(TLUXE_MT5_BRIDGE_TOKEN_SHA256="plain-token"))


class TestAuthPrimitives(unittest.TestCase):
    def test_scrypt(self):
        self.assertTrue(verify_password(PASSWORD, PW_HASH))
        self.assertFalse(verify_password("nope", PW_HASH))
        self.assertFalse(verify_password(PASSWORD, "garbage"))
        self.assertNotIn(PASSWORD, PW_HASH)


class TestPbkdf2AndOfflineTool(unittest.TestCase):
    def test_pbkdf2_verify_and_weak_parameters_rejected(self):
        h = hash_password_pbkdf2(PASSWORD)
        self.assertTrue(h.startswith("pbkdf2_sha256$600000$"))
        self.assertTrue(verify_password(PASSWORD, h))
        self.assertFalse(verify_password(PASSWORD + "x", h))
        weak = hash_password_pbkdf2(PASSWORD, iterations=1000)
        self.assertFalse(verify_password(PASSWORD, weak))  # below the 600,000-iteration floor -> never accepted
        self.assertFalse(verify_password(PASSWORD, "pbkdf2_sha256$600000$$"))
        self.assertIsNotNone(from_env(prod_env(TLUXE_OWNER_PASSWORD_HASH=h)))  # format accepted by the config

    def test_offline_html_tool_output_is_accepted_by_the_gateway(self):
        """The browser tool (tools/owner-password-hash.html, WebCrypto) and the gateway must agree byte for byte."""
        import re
        import shutil
        import subprocess

        node = shutil.which("node")
        if not node:
            self.skipTest("node not installed")
        html = (Path(__file__).resolve().parents[3] / "tools" / "owner-password-hash.html").read_text()
        fn = re.search(r"/\*HASH-BEGIN\*/(.*)/\*HASH-END\*/", html, re.S).group(1)
        self.assertNotIn("fetch(", html)
        self.assertIn("default-src 'none'", html)  # the page cannot send anything anywhere
        script = fn + "\ntluxeOwnerHash(process.argv[1], new Uint8Array(16).map((_, i) => i * 7 + 1), 600000).then((h) => console.log(h));"
        out = subprocess.run([node, "-e", script, PASSWORD], capture_output=True, text=True, timeout=60, check=True).stdout.strip()
        self.assertTrue(out.startswith("pbkdf2_sha256$600000$"), out)
        self.assertTrue(verify_password(PASSWORD, out))
        self.assertFalse(verify_password("wrong password here", out))


class TestGlobalFailLimiter(unittest.TestCase):
    def test_pauses_all_logins_for_the_rest_of_the_minute_then_heals(self):
        now = [1000.0]
        g = GlobalFailLimiter(cap=3, clock=lambda: now[0])
        for _ in range(3):
            self.assertEqual(g.blocked(), 0.0)
            g.fail()
        self.assertGreater(g.blocked(), 0.0)
        now[0] += 61
        self.assertEqual(g.blocked(), 0.0)


class TestHealthModel(unittest.TestCase):
    def ms(self, *a):
        return int(datetime(*a, tzinfo=timezone.utc).timestamp() * 1000)

    def test_market_hours(self):
        self.assertTrue(H.globex_open(self.ms(2026, 10, 14, 15, 0)))    # Wed 11:00 ET
        self.assertFalse(H.globex_open(self.ms(2026, 10, 14, 21, 30)))  # Wed 17:30 ET daily break
        self.assertFalse(H.globex_open(self.ms(2026, 10, 17, 15, 0)))   # Saturday
        self.assertFalse(H.globex_open(self.ms(2026, 10, 18, 21, 0)))   # Sun 17:00 ET
        self.assertTrue(H.globex_open(self.ms(2026, 10, 18, 22, 30)))   # Sun 18:30 ET
        self.assertFalse(H.globex_open(self.ms(2026, 10, 16, 21, 30)))  # Fri 17:30 ET

    def test_live_requires_fresh_data_and_closures_are_expected_stale(self):
        now = self.ms(2026, 10, 14, 15, 0)
        self.assertEqual(H.market_state(True, now - 5_000, now, True, "x")["state"], "LIVE")
        self.assertEqual(H.market_state(True, now - 600_000, now, True, "x")["state"], "STALE")
        self.assertEqual(H.market_state(True, None, now, True, "x")["state"], "STALE")  # running process != LIVE
        closed = H.market_state(True, now - 3_600_000, now, False, "x")
        self.assertEqual((closed["state"], closed["expected"], closed["marketOpen"]), ("STALE", True, False))
        self.assertEqual(H.market_state(False, now, now, True, "x")["state"], "NOT CONNECTED")

    def test_provider_state_mapping(self):
        svc, prov = H.ai_states(None, False, None)
        self.assertEqual((svc["state"], prov["state"]), ("NOT CONNECTED", "NOT CONNECTED"))
        svc, prov = H.ai_states(None, True, "down")
        self.assertEqual((svc["state"], prov["state"]), ("UNAVAILABLE", "UNAVAILABLE"))
        svc, prov = H.ai_states({"status": "NOT_CONFIGURED", "permissions": {"readOnly": True}}, True, None)
        self.assertEqual((svc["state"], prov["state"], svc["readOnly"]), ("LIVE", "NOT CONNECTED", True))
        self.assertEqual(H.ai_states({"status": "AUTH_ERROR"}, True, None)[1]["state"], "ERROR")
        self.assertEqual(H.ai_states({"status": "CONNECTED", "model": "m"}, True, None)[1]["state"], "LIVE")
        self.assertEqual(H.news_state(None, False, None)["state"], "NOT CONNECTED")
        self.assertEqual(H.news_state({"feeds": {"calendar": {"status": "NOT_CONFIGURED"}}}, True, None)["state"], "NOT CONNECTED")
        self.assertEqual(H.news_state({"feeds": {"calendar": {"status": "DELAYED"}}}, True, None)["state"], "DELAYED")
        now = self.ms(2026, 10, 14, 15, 0)
        self.assertEqual(H.databento_state(None, True, "x", now)["state"], "UNAVAILABLE")
        h = {"plan": "standard", "sessions": {"tape": {"state": "CONNECTED"}}, "instruments": {"GC": {"status": "LIVE", "lastEventNs": (now - 2000) * 1_000_000}}}
        d = H.databento_state(h, True, None, now)
        self.assertEqual((d["state"], d["depth"]), ("LIVE", "UNSUPPORTED"))
        h["instruments"]["GC"]["status"] = "AUTH_ERROR"
        self.assertEqual(H.databento_state(h, True, None, now)["state"], "ERROR")
        self.assertEqual(H.mt5_states({"connected": False}, None, now)[0]["state"], "NOT CONNECTED")


class TestLogs(unittest.TestCase):
    def test_redaction(self):
        c = from_env(prod_env(TLUXE_AI_URL="http://ai:8767", TLUXE_AI_TOKEN=AI_TOKEN, TLUXE_NEWS_URL="http://n:8768", TLUXE_NEWS_TOKEN=NEWS_TOKEN))
        stream = io.StringIO()
        setup_logging("json", redactor_for(c))
        h = logging.getLogger().handlers[0]
        h.stream = stream
        logging.getLogger("tluxe.test").warning("dsn %s token %s news %s key sk-proj-abcdefghijk bearer Bearer %s te ?c=client:secret1",
                                                c.database_url.reveal(), AI_TOKEN, NEWS_TOKEN, BRIDGE_TOKEN)
        out = stream.getvalue()
        for s in ("dbpass123", AI_TOKEN, NEWS_TOKEN, "sk-proj-abcdefghijk", BRIDGE_TOKEN, "client:secret1"):
            self.assertNotIn(s, out)
        self.assertEqual(json.loads(out.strip().splitlines()[-1])["level"], "WARNING")


# ------------------------------------------------------------------ fake internal services (TEST DATA)
def fake_services(state: dict) -> web.Application:
    app = web.Application()

    def check(request, token):
        state.setdefault("auth", []).append(request.headers.get("Authorization"))
        return request.headers.get("Authorization") == f"Bearer {token}"

    async def ai_health(request):
        if not check(request, AI_TOKEN):
            return web.json_response({"error": "unauthorized"}, status=401)
        return web.json_response({"service": "tluxe-ai", "status": state.get("aiStatus", "NOT_CONFIGURED"), "connected": state.get("aiStatus") == "CONNECTED",
                                  "model": "gpt-5.5", "permissions": {"readOnly": True, "tools": []}})

    async def ai_chat(request):
        if not check(request, AI_TOKEN):
            return web.json_response({"error": "unauthorized"}, status=401)
        body = await request.json()
        state["chat"] = body
        return web.json_response({"text": f"echo {body['messages'][-1]['content']}", "model": "gpt-5.5"})

    async def db_health(request):
        if not check(request, DB_TOKEN):
            return web.json_response({}, status=401)
        return web.json_response({"plan": "standard", "sessions": {"tape": {"state": "DISCONNECTED"}}, "instruments": {"GC": {"status": "RECONNECTING", "lastEventNs": None}},
                                  "metrics": {"cursor": 5}})

    async def db_feed(request):
        if not check(request, DB_TOKEN):
            return web.json_response({}, status=401)
        c = int(request.query.get("cursor", 0))
        return web.json_response({"cursor": c + 1, "reset": False, "frames": [{"cursor": c + 1, "timeMs": 1, "instruments": {}}]})

    async def news_health(request):
        if not check(request, NEWS_TOKEN):
            return web.json_response({}, status=401)
        return web.json_response({"startedAtMs": 1, "feeds": {"calendar": {"status": "NOT_CONFIGURED", "detail": "TRADING_ECONOMICS_API_KEY is not set."}}})

    async def news_calendar(request):
        return web.json_response({"seq": 0, "reset": False, "events": []})

    async def news_headlines(request):
        return web.json_response({"seq": 0, "reset": False, "headlines": []})

    app.router.add_get("/api/ai/health", ai_health)
    app.router.add_post("/api/ai/chat", ai_chat)
    app.router.add_get("/v1/health", db_health)
    app.router.add_get("/v1/feed", db_feed)
    app.router.add_get("/v1/calendar", news_calendar)
    app.router.add_get("/v1/headlines", news_headlines)
    return app


class GatewayCase(unittest.IsolatedAsyncioTestCase):
    """Starts the gateway (and stand-in services) on ephemeral ports."""

    prod = False
    workers = False
    extra_env: dict = {}
    store_factory = staticmethod(lambda cfg: MemoryStore())

    async def asyncSetUp(self) -> None:
        self.fake_state: dict = {}
        self.ai_srv = TestServer(fake_services(self.fake_state))
        await self.ai_srv.start_server()
        news_app = web.Application()
        ns = fake_services(self.fake_state)

        async def nh(request):
            return web.json_response({"startedAtMs": 1, "feeds": {"calendar": {"status": "NOT_CONFIGURED", "detail": "TRADING_ECONOMICS_API_KEY is not set."}}}) \
                if request.headers.get("Authorization") == f"Bearer {NEWS_TOKEN}" else web.json_response({}, status=401)

        news_app.router.add_get("/v1/health", nh)
        for route in ns.router.routes():
            if route.resource.canonical in ("/v1/calendar", "/v1/headlines"):
                news_app.router.add_route(route.method, route.resource.canonical, route.handler)
        self.news_srv = TestServer(news_app)
        await self.news_srv.start_server()
        base = f"http://127.0.0.1:{self.ai_srv.port}"
        env = (prod_env if self.prod else dev_env)(TLUXE_AI_URL=base, TLUXE_AI_TOKEN=AI_TOKEN, TLUXE_DATABENTO_URL=base, TLUXE_DB_BRIDGE_TOKEN=DB_TOKEN,
                                                    TLUXE_NEWS_URL=f"http://127.0.0.1:{self.news_srv.port}", TLUXE_NEWS_TOKEN=NEWS_TOKEN,
                                                    TLUXE_MT5_BRIDGE_TOKEN_SHA256=BRIDGE_SHA, **self.extra_env)
        self.cfg = from_env(env)
        self.store = self.store_factory(self.cfg)
        self.app = make_app(self.cfg, store=self.store, workers=self.workers)
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        self.origin = APP if self.prod else "http://localhost:5182"

    async def asyncTearDown(self) -> None:
        await self.client.close()
        await self.ai_srv.close()
        await self.news_srv.close()

    async def login(self) -> str:
        r = await self.client.post("/api/auth/login", json={"password": PASSWORD}, headers={"Origin": self.origin})
        self.assertEqual(r.status, 200, await r.text())
        return r.cookies[COOKIE].value

    def ck(self, sid: str) -> dict:
        return {"Cookie": f"{COOKIE}={sid}", "Origin": self.origin}


class TestGatewayDev(GatewayCase):
    async def test_public_endpoints_and_auth_required(self):
        self.assertEqual((await self.client.get("/healthz")).status, 200)
        self.assertEqual(await (await self.client.get("/healthz")).json(), {"ok": True})
        for path in ("/api/status", "/api/auth/me", "/api/ai/health", "/api/databento/v1/health", "/api/news/v1/health", "/api/mt5/v1/health"):
            self.assertEqual((await self.client.get(path)).status, 401, path)
        self.assertEqual((await self.client.post("/api/ai/chat", json={})).status, 401)

    async def test_login_session_logout(self):
        r = await self.client.post("/api/auth/login", json={"password": "wrong"}, headers={"Origin": self.origin})
        self.assertEqual(r.status, 401)
        sid = await self.login()
        r = await self.client.get("/api/auth/me", headers=self.ck(sid))
        self.assertEqual((r.status, (await r.json())["readOnly"]), (200, True))
        await self.client.post("/api/auth/logout", headers=self.ck(sid))
        self.assertEqual((await self.client.get("/api/auth/me", headers=self.ck(sid))).status, 401)

    async def test_login_rate_limited(self):
        for _ in range(5):
            await self.client.post("/api/auth/login", json={"password": "wrong"}, headers={"Origin": self.origin})
        r = await self.client.post("/api/auth/login", json={"password": PASSWORD}, headers={"Origin": self.origin})
        self.assertEqual(r.status, 429)

    async def test_proxies_keep_tokens_server_side(self):
        sid = await self.login()
        r = await self.client.get("/api/ai/health", headers=self.ck(sid))
        body = await r.text()
        self.assertEqual(r.status, 200)
        self.assertNotIn(AI_TOKEN, body)
        r = await self.client.post("/api/ai/chat", json={"mode": "chat", "messages": [{"role": "user", "content": "hi"}]}, headers=self.ck(sid))
        self.assertEqual((await r.json())["text"], "echo hi")
        self.assertIn(f"Bearer {AI_TOKEN}", self.fake_state["auth"])  # the gateway, not the browser, holds the token
        self.assertEqual((await self.client.get("/api/databento/v1/health", headers=self.ck(sid))).status, 200)
        self.assertEqual((await self.client.get("/api/databento/v1/../../etc/passwd", headers=self.ck(sid))).status, 404)
        self.assertEqual((await self.client.get("/api/databento/v1/orders", headers=self.ck(sid))).status, 404)
        self.assertEqual((await self.client.get("/api/news/v1/health", headers=self.ck(sid))).status, 200)
        self.assertEqual((await self.client.get("/api/unknown", headers=self.ck(sid))).status, 404)

    async def test_status_disconnected_providers_never_live(self):
        sid = await self.login()
        st = await (await self.client.get("/api/status", headers=self.ck(sid))).json()
        c = st["components"]
        self.assertEqual(c["api"]["state"], "LIVE")
        self.assertEqual(c["ai"]["state"], "LIVE")                 # service answers
        self.assertEqual(c["openai"]["state"], "NOT CONNECTED")    # but OpenAI is not configured
        self.assertEqual(c["databento"]["state"], "NOT CONNECTED")  # tape session not connected
        self.assertEqual(c["news"]["state"], "NOT CONNECTED")
        self.assertEqual(c["mt5Bridge"]["state"], "NOT CONNECTED")
        self.assertEqual(c["mt5Feed"]["state"], "NOT CONNECTED")
        self.assertEqual(c["postgres"]["state"], "NOT CONNECTED")  # dev in-memory store is not a database
        self.assertNotIn("LIVE", {c[k]["state"] for k in ("openai", "databento", "news", "mt5Feed")})
        self.assertNotIn(AI_TOKEN, json.dumps(st))

    async def test_cors_strict(self):
        r = await self.client.get("/healthz", headers={"Origin": "https://evil.example"})
        self.assertNotIn("Access-Control-Allow-Origin", r.headers)
        r = await self.client.get("/api/config", headers={"Origin": "https://evil.example"})
        self.assertEqual(r.status, 403)
        r = await self.client.get("/api/config", headers={"Origin": "http://localhost:5182"})
        self.assertEqual(r.headers.get("Access-Control-Allow-Origin"), "http://localhost:5182")
        self.assertNotEqual(r.headers.get("Access-Control-Allow-Origin"), "*")
        self.assertEqual(r.headers.get("X-Frame-Options"), "DENY")
        self.assertIn("frame-ancestors 'none'", r.headers.get("Content-Security-Policy"))

    async def test_websocket_requires_session_and_origin_then_streams(self):
        with self.assertRaises(Exception):
            await self.client.ws_connect("/api/stream", headers={"Origin": self.origin})
        sid = await self.login()
        with self.assertRaises(Exception):
            await self.client.ws_connect("/api/stream", headers={"Cookie": f"{COOKIE}={sid}", "Origin": "https://evil.example"})
        from tluxe_gateway.app import K_HUB, compute_status
        # An open endpoint is not "live": LIVE only while a browser stream is actually connected.
        self.assertEqual((await compute_status(self.app))["components"]["websocket"]["state"], "NOT CONNECTED")
        ws = await self.client.ws_connect("/api/stream", headers=self.ck(sid))
        hello = await ws.receive_json(timeout=5)
        self.assertEqual((hello["type"], hello["seq"]), ("hello", 1))
        self.assertEqual((await compute_status(self.app))["components"]["websocket"]["state"], "LIVE")
        self.app[K_HUB].publish("status", {"components": {}})
        m = await ws.receive_json(timeout=5)
        self.assertEqual((m["type"], m["seq"]), ("status", 2))
        self.assertIsInstance(m["ts"], int)
        await ws.close()

    async def test_mt5_relay_read_only_authenticated_sequenced(self):
        sid = await self.login()
        r = await self.client.get("/api/mt5/v1/health", headers=self.ck(sid))
        self.assertEqual((r.status, (await r.json())["error"]["code"]), (503, "BRIDGE_OFFLINE"))
        with self.assertRaises(Exception):
            await self.client.ws_connect("/bridge/mt5", headers={"Authorization": "Bearer wrong"})
        link = await self.client.ws_connect("/bridge/mt5", headers={"Authorization": f"Bearer {BRIDGE_TOKEN}", "X-TLUXE-Bridge-Id": "vps-test"})
        seq = 0

        def msg(**kw):
            nonlocal seq
            seq += 1
            return json.dumps({"seq": seq, "ts": int(time.time() * 1000), **kw})

        await link.send_str(msg(type="hello", bridgeId="vps-test"))

        async def serve_one():
            req = json.loads((await link.receive(timeout=5)).data)
            while req.get("type") != "request":
                req = json.loads((await link.receive(timeout=5)).data)
            self.assertEqual(req["method"], "GET")
            await link.send_str(msg(type="response", id=req["id"], status=200, body={"symbol": "XAUUSD", "bid": 2400.1, "ask": 2400.3, "timeUtcMs": int(time.time() * 1000)}))
            return req

        task = asyncio.create_task(serve_one())
        r = await self.client.get("/api/mt5/v1/quote/XAUUSD", headers=self.ck(sid))
        req = await task
        self.assertEqual(req["path"], "/v1/quote/XAUUSD")
        self.assertEqual((await r.json())["bid"], 2400.1)
        # Read-only: other methods and non-allowlisted paths never reach the VPS.
        self.assertEqual((await self.client.post("/api/mt5/v1/order", json={}, headers=self.ck(sid))).status, 405)
        r = await self.client.get("/api/mt5/v1/order_send", headers=self.ck(sid))
        self.assertEqual(r.status, 403)
        self.assertFalse(read_only_path("/v1/orders"))
        self.assertFalse(read_only_path("/v1/trade/close"))
        self.assertTrue(read_only_path("/v1/rates/XAUUSD?timeframe=M1&count=500"))
        # Replay / skew protection.
        from tluxe_gateway.app import K_RELAY
        relay = self.app[K_RELAY]
        before = dict(relay.counts)
        await link.send_str(json.dumps({"type": "heartbeat", "seq": 1, "ts": int(time.time() * 1000)}))  # replayed seq
        await link.send_str(json.dumps({"type": "heartbeat", "seq": 999, "ts": int(time.time() * 1000) - 120_000}))  # skewed
        await asyncio.sleep(0.2)
        self.assertEqual(relay.counts["rejectedReplay"], before["rejectedReplay"] + 1)
        self.assertEqual(relay.counts["rejectedSkew"], before["rejectedSkew"] + 1)
        self.assertEqual(relay.status()["bridgeId"], "vps-test")
        await link.close()


class TestIbkrDepth(GatewayCase):
    """IBKR COMEX Level-2 depth relay. TEST DATA ONLY: a scripted VPS bridge speaks the link protocol."""

    extra_env = {"TLUXE_IBKR_BRIDGE_TOKEN_SHA256": IBKR_SHA}

    async def _link(self):
        link = await self.client.ws_connect("/bridge/ibkr", headers={"Authorization": f"Bearer {IBKR_TOKEN}", "X-TLUXE-Bridge-Id": "ibkr-vps-test"})
        seq = 0

        async def send(**kw):
            nonlocal seq
            seq += 1
            await link.send_str(json.dumps({"seq": seq, "ts": int(time.time() * 1000), **kw}))
            await asyncio.sleep(0.05)

        return link, send

    async def test_auth_config_flag_and_offline_state(self):
        with self.assertRaises(Exception):
            await self.client.ws_connect("/bridge/ibkr", headers={"Authorization": "Bearer wrong"})
        self.assertTrue((await (await self.client.get("/api/config")).json())["ibkrDepth"])
        self.assertEqual((await self.client.get("/api/ibkr/status")).status, 401)  # owner login active: session required
        sid = await self.login()
        st = await (await self.client.get("/api/ibkr/status", headers=self.ck(sid))).json()
        self.assertEqual((st["configured"], st["roots"]["GC"]["state"], st["roots"]["GC"]["valid"]), (True, "OFFLINE", False))
        b = await (await self.client.get("/api/ibkr/book?root=GC", headers=self.ck(sid))).json()
        self.assertEqual((b["valid"], b["bids"], b["asks"]), (False, [], []))  # no depth is ever served while offline
        self.assertEqual((await self.client.get("/api/ibkr/book?root=XAUUSD", headers=self.ck(sid))).status, 400)

    async def test_book_updates_gap_reset_and_link_loss(self):
        from tluxe_gateway.app import K_IBKR
        relay = self.app[K_IBKR]
        sid = await self.login()
        link, send = await self._link()
        await send(type="hello", bridgeId="ibkr-vps-test")
        contract = {"conId": 462941472, "localSymbol": "GCZ6", "exchange": "COMEX", "currency": "USD", "expiry": "20261229", "minTick": 0.1}
        await send(type="health", session={"state": "LIVE", "apiConnected": True, "detail": None, "lastError": {"code": 10090, "message": "acct U1234567"}},
                   roots={"GC": {"state": "LIVE", "rowsRequested": 10}})
        await send(type="book", root="GC", depthSeq=10, valid=True, contract=contract, bids=[[4150.0, 5], [4149.9, 7]], asks=[[4150.1, 3]])
        b = await (await self.client.get("/api/ibkr/book?root=GC", headers=self.ck(sid))).json()
        self.assertEqual((b["valid"], b["depthSeq"], b["bids"][0], b["asks"][0], b["contract"]["localSymbol"]), (True, 10, [4150.0, 5.0], [4150.1, 3.0], "GCZ6"))
        now = int(time.time() * 1000)
        await send(type="depth", root="GC", changes=[[11, "bid", 4150.0, 9, "update", 0, now], [12, "ask", 4150.1, 0, "delete", 0, now]])
        u = await (await self.client.get(f"/api/ibkr/updates?root=GC&epoch={b['epoch']}&after=10", headers=self.ck(sid))).json()
        self.assertEqual((u["resync"], [c[:4] for c in u["changes"]]), (False, [[11, "bid", 4150.0, 9.0], [12, "ask", 4150.1, 0.0]]))
        # A depth sequence gap invalidates the book and asks the bridge for a fresh snapshot.
        await send(type="depth", root="GC", changes=[[20, "bid", 4149.0, 1, "insert", 3, now]])
        req = json.loads((await link.receive(timeout=5)).data)
        while req.get("type") != "snapshot":
            req = json.loads((await link.receive(timeout=5)).data)
        self.assertEqual(req["root"], "GC")
        g = await (await self.client.get("/api/ibkr/book?root=GC", headers=self.ck(sid))).json()
        self.assertEqual((g["valid"], g["bids"]), (False, []))
        u2 = await (await self.client.get(f"/api/ibkr/updates?root=GC&epoch={b['epoch']}&after=12", headers=self.ck(sid))).json()
        self.assertTrue(u2["resync"])
        # Reset = known empty baseline; IBKR rebuilds with fresh rows.
        await send(type="reset", root="GC", depthSeq=30, reason="IBKR 317: Market depth data has been RESET")
        await send(type="depth", root="GC", changes=[[31, "bid", 4151.0, 2, "insert", 0, now]])
        r = await (await self.client.get("/api/ibkr/book?root=GC", headers=self.ck(sid))).json()
        self.assertEqual((r["valid"], r["bids"]), (True, [[4151.0, 2.0]]))
        st = await (await self.client.get("/api/ibkr/status", headers=self.ck(sid))).json()
        self.assertNotIn("U1234567", json.dumps(st))  # account ids never leave the gateway
        self.assertEqual(st["roots"]["GC"]["state"], "LIVE")
        self.assertIn("MBO", st["depthType"])
        # AUTH REQUIRED stops depth immediately.
        await send(type="health", session={"state": "AUTH_REQUIRED", "detail": "IBKR login / 2FA required"}, roots={"GC": {"state": "OFFLINE"}})
        a = await (await self.client.get("/api/ibkr/book?root=GC", headers=self.ck(sid))).json()
        self.assertEqual((a["state"], a["valid"], a["bids"]), ("AUTH_REQUIRED", False, []))
        # Link loss clears every book.
        await link.close()
        await asyncio.sleep(0.2)
        o = await (await self.client.get("/api/ibkr/book?root=GC", headers=self.ck(sid))).json()
        self.assertEqual((o["state"], o["valid"], o["bids"]), ("OFFLINE", False, []))
        self.assertEqual(relay.books["GC"].bids, {})

    async def test_targets_follow_the_databento_contract_and_replay_is_rejected(self):
        from tluxe_gateway.app import K_IBKR
        relay = self.app[K_IBKR]
        link, send = await self._link()
        await send(type="hello")
        await relay.tick({"GC": "GCZ6", "SI": "SIZ6", "ES": "ESZ6"})
        m = json.loads((await link.receive(timeout=5)).data)
        self.assertEqual((m["type"], m["roots"]), ("targets", {"GC": "GCZ6", "SI": "SIZ6"}))
        before = dict(relay.counts)
        await link.send_str(json.dumps({"type": "heartbeat", "seq": 1, "ts": int(time.time() * 1000)}))  # replay
        await link.send_str(json.dumps({"type": "heartbeat", "seq": 99, "ts": int(time.time() * 1000) - 120_000}))  # skew
        await asyncio.sleep(0.2)
        self.assertEqual(relay.counts["rejectedReplay"], before["rejectedReplay"] + 1)
        self.assertEqual(relay.counts["rejectedSkew"], before["rejectedSkew"] + 1)
        # A LIVE IBKR book of a different expiry than Databento's is withheld (never mixed across a roll).
        await link.send_str(json.dumps({"seq": 100, "ts": int(time.time() * 1000), "type": "health", "session": {"state": "LIVE", "apiConnected": True}, "roots": {"GC": {"state": "LIVE"}}}))
        await link.send_str(json.dumps({"seq": 101, "ts": int(time.time() * 1000), "type": "book", "root": "GC", "depthSeq": 5, "valid": True,
                                        "contract": {"conId": 760200541, "localSymbol": "GCX6"}, "bids": [[4150.0, 1]], "asks": [[4150.1, 1]]}))
        await asyncio.sleep(0.2)
        bk = relay.book("GC")
        self.assertEqual((bk["state"], bk["valid"], bk["bids"]), ("CONTRACT_MISMATCH", False, []))
        await link.close()


class TestGatewayWorkers(GatewayCase):
    workers = True

    async def test_databento_frames_pushed_only_to_subscribers_and_status_broadcast(self):
        sid = await self.login()
        ws = await self.client.ws_connect("/api/stream", headers=self.ck(sid))
        seen, seqs = set(), []
        for _ in range(10):
            m = await ws.receive_json(timeout=15)
            seqs.append(m["seq"])
            seen.add(m["type"])
            if m["type"] == "status":
                break
        self.assertIn("status", seen)  # status worker broadcasts without polling from the browser
        await ws.send_json({"type": "subscribe", "channels": ["databento"]})
        kinds = set()
        for _ in range(20):
            m = await ws.receive_json(timeout=10)
            seqs.append(m["seq"])
            if m["type"] == "databento":
                kinds.add(m["data"]["kind"])
            if {"health", "frames"} <= kinds:
                break
        self.assertTrue({"health", "frames"} <= kinds)
        self.assertEqual(seqs, sorted(seqs))  # strictly increasing per-connection sequence
        self.assertEqual(len(seqs), len(set(seqs)))
        await ws.close()

    async def test_a_connecting_browser_sees_its_own_stream_reported_promptly(self):
        sid = await self.login()
        await asyncio.sleep(0.3)  # first status computed with no browser stream
        ws = await self.client.ws_connect("/api/stream", headers=self.ck(sid))
        t0, state = time.monotonic(), None
        while time.monotonic() - t0 < 5:
            m = await ws.receive_json(timeout=5)
            if m["type"] == "status":
                state = m["data"]["components"]["websocket"]["state"]
                if state == "LIVE":
                    break
        self.assertEqual(state, "LIVE")
        self.assertLess(time.monotonic() - t0, 5)  # not the 10 s status cycle
        await ws.close()


@unittest.skipUnless(PG_ADMIN, "TLUXE_TEST_DATABASE_URL not set - production-mode tests need PostgreSQL (never faked)")
class PgGatewayCase(GatewayCase):
    """Production mode runs only on PostgreSQL: each test gets a fresh temporary database."""

    prod = True

    async def asyncSetUp(self) -> None:
        import psycopg

        self.dbname = f"tluxe_prod_{uuid.uuid4().hex[:10]}"
        async with await psycopg.AsyncConnection.connect(PG_ADMIN, autocommit=True) as c:
            await c.execute(f'CREATE DATABASE "{self.dbname}"')
        dsn = f"{PG_ADMIN.rsplit('/', 1)[0]}/{self.dbname}"
        self.store_factory = lambda cfg: PgStore(dsn)
        await super().asyncSetUp()

    async def asyncTearDown(self) -> None:
        import psycopg

        await super().asyncTearDown()
        async with await psycopg.AsyncConnection.connect(PG_ADMIN, autocommit=True) as c:
            await c.execute(f'DROP DATABASE IF EXISTS "{self.dbname}" WITH (FORCE)')


@unittest.skipUnless(PG_ADMIN, "TLUXE_TEST_DATABASE_URL not set - production-mode tests need PostgreSQL (never faked)")
class TestGatewayProduction(PgGatewayCase):
    async def test_production_refuses_memory_store(self):
        app = make_app(self.cfg, store=MemoryStore(), workers=False)
        with self.assertRaises(RuntimeError):
            async with TestClient(TestServer(app)):
                pass

    async def test_secure_cookie_and_prod_headers(self):
        r = await self.client.post("/api/auth/login", json={"password": PASSWORD}, headers={"Origin": APP})
        sc = r.headers.getall("Set-Cookie")
        main = [c for c in sc if c.startswith(f"{COOKIE}=")][0]
        for attr in ("HttpOnly", "Secure", "SameSite=Strict", "Path=/"):
            self.assertIn(attr, main)
        r = await self.client.get("/api/config", headers={"Origin": APP})
        self.assertIn("max-age", r.headers.get("Strict-Transport-Security", ""))
        self.assertEqual((await self.client.get("/api/config", headers={"Origin": "http://localhost:5182"})).status, 403)

    async def test_state_change_requires_origin(self):
        sid = (await self.client.post("/api/auth/login", json={"password": PASSWORD}, headers={"Origin": APP})).cookies[COOKIE].value
        r = await self.client.post("/api/alerts", json={}, headers={"Cookie": f"{COOKIE}={sid}"})
        self.assertEqual(r.status, 403)


@unittest.skipUnless(PG_ADMIN, "TLUXE_TEST_DATABASE_URL not set - production-mode tests need PostgreSQL (never faked)")
class TestOwnerModeProduction(PgGatewayCase):
    """Production WITH the owner hash configured: public market-data mode is OFF and every private route needs a session."""

    extra_env = {"TLUXE_OWNER_PASSWORD_HASH": hash_password_pbkdf2(PASSWORD)}

    async def test_everything_private_is_denied_without_a_session(self):
        self.assertFalse(self.cfg.public_market_data)
        c = await (await self.client.get("/api/config")).json()
        self.assertEqual((c["authRequired"], c["publicMarketData"]), (True, False))
        self.assertEqual(await (await self.client.get("/healthz")).json(), {"ok": True})  # minimal public health only
        for path in ("/api/databento/status?root=GC", "/api/databento/status?root=SI", "/api/databento/v1/health",
                     "/api/databento/v1/feed?cursor=0&roots=GC", "/api/databento/v1/candles/GC?timeframe=M1",
                     "/api/databento/v1/candles/SI?timeframe=H1", "/api/databento/v1/trades/SI?after=0&limit=10",
                     "/api/mt5/v1/health", "/api/mt5/v1/quote/XAUUSD", "/api/status", "/api/auth/me", "/api/ai/health", "/api/news/v1/health"):
            r = await self.client.get(path, headers={"Origin": APP})
            self.assertEqual(r.status, 401, path)
            body = await r.text()
            for secret in (DB_TOKEN, AI_TOKEN, NEWS_TOKEN, PASSWORD, self.cfg.owner_password_hash.reveal()):
                self.assertNotIn(secret, body)
        for path in ("/api/alerts", "/api/snapshots", "/api/ai/chat"):
            self.assertEqual((await self.client.post(path, json={}, headers={"Origin": APP})).status, 401, path)
        with self.assertRaises(Exception):
            await self.client.ws_connect("/api/stream", headers={"Origin": APP})

    async def test_owner_session_reads_market_data_then_logout_ends_it(self):
        r = await self.client.post("/api/auth/login", json={"password": PASSWORD}, headers={"Origin": APP})
        self.assertEqual(r.status, 200)
        sid = r.cookies[COOKIE].value
        hdr = {"Cookie": f"{COOKIE}={sid}", "Origin": APP}
        self.assertEqual((await self.client.get("/api/databento/status?root=GC", headers=hdr)).status, 200)
        self.assertEqual((await self.client.get("/api/databento/v1/health", headers=hdr)).status, 200)
        ws = await self.client.ws_connect("/api/stream", headers=hdr)  # the owner session opens the private stream
        await ws.close()
        self.assertEqual((await self.client.post("/api/auth/logout", headers=hdr)).status, 200)
        self.assertEqual((await self.client.get("/api/databento/status?root=GC", headers=hdr)).status, 401)
        with self.assertRaises(Exception):
            await self.client.ws_connect("/api/stream", headers=hdr)

    async def test_login_and_logout_require_the_app_origin(self):
        self.assertEqual((await self.client.post("/api/auth/login", json={"password": PASSWORD})).status, 403)
        self.assertEqual((await self.client.post("/api/auth/login", json={"password": PASSWORD}, headers={"Origin": "https://evil.example"})).status, 403)
        self.assertEqual((await self.client.post("/api/auth/logout")).status, 403)

    async def test_failed_login_is_generic_and_lockout_is_per_real_client(self):
        r = await self.client.post("/api/auth/login", json={"password": "not the password"}, headers={"Origin": APP, "X-Forwarded-For": "203.0.113.9"})
        body = await r.json()
        self.assertEqual((r.status, body["error"]["code"], body["error"]["message"]), (401, "INVALID_CREDENTIALS", "Sign-in failed."))
        for _ in range(4):
            await self.client.post("/api/auth/login", json={"password": "not the password"}, headers={"Origin": APP, "X-Forwarded-For": "203.0.113.9"})
        r = await self.client.post("/api/auth/login", json={"password": PASSWORD}, headers={"Origin": APP, "X-Forwarded-For": "203.0.113.9"})
        self.assertEqual(r.status, 429)  # that client is locked out, even with the right password
        r = await self.client.post("/api/auth/login", json={"password": PASSWORD}, headers={"Origin": APP, "X-Forwarded-For": "198.51.100.7"})
        self.assertEqual(r.status, 200)  # the owner on another address is not locked out by someone else's guesses
        self.assertNotIn("TLUXE_", json.dumps(body))

    async def test_session_survives_a_gateway_restart(self):
        sid = (await self.client.post("/api/auth/login", json={"password": PASSWORD}, headers={"Origin": APP})).cookies[COOKIE].value
        await self.client.close()
        app2 = make_app(self.cfg, store=self.store_factory(self.cfg), workers=False)
        self.client = TestClient(TestServer(app2))
        await self.client.start_server()
        r = await self.client.get("/api/auth/me", headers={"Cookie": f"{COOKIE}={sid}", "Origin": APP})
        self.assertEqual(r.status, 200)


@unittest.skipUnless(PG_ADMIN, "TLUXE_TEST_DATABASE_URL not set - production-mode tests need PostgreSQL (never faked)")
class TestPublicMarketDataMode(PgGatewayCase):
    """Production with NO owner hash yet: only read-only Databento GETs are public; everything else stays 401."""

    extra_env = {"TLUXE_OWNER_PASSWORD_HASH": ""}

    async def test_only_databento_reads_are_public(self):
        self.assertTrue(self.cfg.public_market_data)
        c = await (await self.client.get("/api/config")).json()
        self.assertEqual((c["authRequired"], c["publicMarketData"]), (False, True))
        for path in ("/api/databento/v1/health", "/api/databento/v1/feed?cursor=0&roots=GC", "/api/databento/status?root=GC"):
            r = await self.client.get(path)
            self.assertEqual(r.status, 200, path)
            self.assertNotIn(DB_TOKEN, await r.text())
        # MT5 relay: readable without login, still read-only; no VPS link attached -> honest 503 BRIDGE_OFFLINE, never data.
        r = await self.client.get("/api/mt5/v1/quote/XAUUSD")
        self.assertEqual((r.status, (await r.json())["error"]["code"]), (503, "BRIDGE_OFFLINE"))
        self.assertEqual((await self.client.post("/api/mt5/v1/quote/XAUUSD", headers={"Origin": APP})).status, 401)
        self.assertEqual((await self.client.get("/api/mt5/v1/order_send")).status, 403)
        for method, path in (("GET", "/api/status"), ("GET", "/api/auth/me"), ("GET", "/api/ai/health"), ("POST", "/api/ai/chat"),
                             ("GET", "/api/news/v1/health"), ("POST", "/api/alerts"), ("POST", "/api/snapshots")):
            r = await self.client.request(method, path, headers={"Origin": APP}, json={} if method == "POST" else None)
            self.assertEqual(r.status, 401, f"{method} {path}")
        with self.assertRaises(Exception):
            await self.client.ws_connect("/api/stream", headers={"Origin": APP})
        r = await self.client.post("/api/auth/login", json={"password": "anything-at-all"}, headers={"Origin": APP})
        self.assertEqual((r.status, (await r.json())["error"]["code"]), (503, "AUTH_NOT_CONFIGURED"))
        self.assertIn("Strict-Transport-Security", (await self.client.get("/api/config")).headers)


class TestPublicRateLimiter(unittest.TestCase):
    def test_bucket_limits_then_refills_per_client(self):
        from tluxe_gateway.app import PublicRateLimiter
        t = [0.0]
        lim = PublicRateLimiter(rate_per_s=2, burst=3, clock=lambda: t[0])
        self.assertEqual([lim.allow("a") for _ in range(4)], [True, True, True, False])
        self.assertTrue(lim.allow("b"))  # other clients unaffected
        t[0] += 1.0
        self.assertEqual([lim.allow("a") for _ in range(3)], [True, True, False])


@unittest.skipUnless(PG_ADMIN, "TLUXE_TEST_DATABASE_URL not set - PostgreSQL tests skipped (never faked)")
class TestPostgres(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        import psycopg

        self.dbname = f"tluxe_test_{uuid.uuid4().hex[:10]}"
        async with await psycopg.AsyncConnection.connect(PG_ADMIN, autocommit=True) as c:
            await c.execute(f'CREATE DATABASE "{self.dbname}"')
        base = PG_ADMIN.rsplit("/", 1)[0]
        self.dsn = f"{base}/{self.dbname}"
        self.store = PgStore(self.dsn)
        await self.store.open()

    async def asyncTearDown(self) -> None:
        import psycopg

        await self.store.close()
        async with await psycopg.AsyncConnection.connect(PG_ADMIN, autocommit=True) as c:
            await c.execute(f'DROP DATABASE IF EXISTS "{self.dbname}" WITH (FORCE)')

    async def test_migrations_apply_once_and_detect_tampering(self):
        applied = await self.store.migrate()
        self.assertEqual(applied, [f[1] for f in migration_files()])
        self.assertEqual(await self.store.migrate(), [])  # idempotent
        self.assertEqual((await self.store.ping())["schemaVersion"], migration_files()[-1][0])
        await self.store._exec("UPDATE schema_migrations SET checksum = 'x' WHERE version = 1")
        with self.assertRaises(RuntimeError):
            await self.store.migrate()

    async def test_schema_guards(self):
        await self.store.migrate()
        await self.store._exec("INSERT INTO app_config (key, value) VALUES ('ui.theme', '\"dark\"')")
        import psycopg

        for bad in ("openai_api_key", "bridge_token", "owner_password"):
            with self.assertRaises(psycopg.errors.CheckViolation):
                await self.store._exec("INSERT INTO app_config (key, value) VALUES (%s, '\"x\"')", (bad,))
        with self.assertRaises(psycopg.errors.CheckViolation):
            await self.store.record_status("service", "api", "FAKE_LIVE", None, None)

    async def test_news_revisions_update_same_row(self):
        await self.store.migrate()
        e = {"dedupKey": "tradingeconomics:1", "provider": "tradingeconomics", "providerEventId": "1", "event": "CPI YoY", "importance": "HIGH", "importanceRaw": 3,
             "scheduledAt": 1_790_000_000_000, "actual": None, "forecast": "3.1%", "previous": "3.2%", "releaseStatus": "SCHEDULED", "receivedAt": 1_789_000_000_000,
             "revision": 0, "raw": {"CalendarId": "1"}}
        self.assertEqual(await self.store.upsert_calendar(e), "new")
        self.assertEqual(await self.store.upsert_calendar(e), "duplicate")
        e2 = {**e, "actual": "3.4%", "releaseStatus": "RELEASED", "revision": 1, "revisions": [{"at": 1_790_000_000_500, "changes": {"actual": [None, "3.4%"]}}]}
        self.assertEqual(await self.store.upsert_calendar(e2), "revised")
        row = await self.store._one("SELECT count(*), max(actual), max(revision) FROM news_calendar_events")
        self.assertEqual(row, (1, "3.4%", 1))
        row = await self.store._one("SELECT revision, changes FROM news_event_revisions")
        self.assertEqual(row, (1, {"actual": [None, "3.4%"]}))
        missing = await self.store._one("SELECT actual FROM news_calendar_events WHERE dedup_key = 'tradingeconomics:1'")
        self.assertEqual(missing[0], "3.4%")

    async def test_status_survives_restart_as_previous_never_as_current(self):
        await self.store.migrate()
        await self.store.record_status("provider", "databento", "LIVE", "fresh trades", True)
        await self.store.record_status("provider", "databento", "STALE", "no data", True)
        await self.store.close()
        store2 = PgStore(self.dsn)  # "restart"
        await store2.open()
        cfg = from_env(dev_env())
        app = make_app(cfg, store=store2, workers=False)
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            r = await client.post("/api/auth/login", json={"password": PASSWORD}, headers={"Origin": "http://localhost:5182"})
            sid = r.cookies[COOKIE].value
            st = await (await client.get("/api/status", headers={"Cookie": f"{COOKIE}={sid}", "Origin": "http://localhost:5182"})).json()
            prev = st["previous"]
            self.assertTrue(prev["restoredFromDatabase"])
            self.assertEqual(prev["components"]["databento"]["state"], "STALE")  # the LAST recorded state
            self.assertEqual(st["components"]["databento"]["state"], "NOT CONNECTED")  # current state is re-observed, not restored
            self.assertEqual(st["components"]["postgres"]["state"], "LIVE")
            # sessions are durable (hash only) and alerts are de-duplicated
            row = await store2._one("SELECT count(*) FROM sessions WHERE id_sha256 = %s", (hashlib.sha256(sid.encode()).hexdigest(),))
            self.assertEqual(row[0], 1)
            a = {"alertKey": "te:1:NEWS_RELEASED", "source": "news", "type": "NEWS_RELEASED", "title": "CPI released", "occurredAt": 1_790_000_000_000}
            h = {"Cookie": f"{COOKIE}={sid}", "Origin": "http://localhost:5182"}
            self.assertTrue((await (await client.post("/api/alerts", json=a, headers=h)).json())["created"])
            self.assertFalse((await (await client.post("/api/alerts", json=a, headers=h)).json())["created"])
            big = {"engine": "smc", "instrumentId": "XAUUSD", "computedAt": 1, "payload": {"x": "y" * 70_000}}
            self.assertEqual((await client.post("/api/snapshots", json=big, headers=h)).status, 413)
            self.assertEqual((await client.post("/api/snapshots", json={**big, "payload": {"x": 1}}, headers=h)).status, 200)
            await store2.retention()
        finally:
            await client.close()


class TestDatabaseStartup(unittest.IsolatedAsyncioTestCase):
    async def test_unreachable_database_retries_then_fails_without_leaking_the_dsn(self):
        from tluxe_gateway.store import PgStore

        dsn = "postgresql://tluxe:secretpw123@127.0.0.1:1/tluxe"  # nothing listens on port 1
        store = PgStore(dsn)
        with self.assertLogs("tluxe.gateway.store", level="WARNING") as logs, self.assertRaises(RuntimeError) as cm:
            await store.open(attempts=2, wait_s=0.5)
        self.assertIn("after 2 attempts", str(cm.exception))
        self.assertEqual(len(logs.records), 2)
        for text in [str(cm.exception)] + logs.output:
            self.assertNotIn("secretpw123", text)


class TestNoTradingSurface(unittest.TestCase):
    def test_gateway_source_has_no_trading_or_shell(self):
        import re

        src = "".join(p.read_text() for p in (Path(__file__).resolve().parents[1] / "tluxe_gateway").glob("*.py"))
        for bad in ("order_send", "subprocess", "os.system", "place_order", "close_position"):
            self.assertNotIn(bad, src, bad)
        self.assertIsNone(re.search(r"(?<![\w.])(eval|exec)\(", src))
        self.assertIsNone(re.search(r"add_(post|put|delete|patch)\(\s*\"/api/(mt5|order|trade)", src))


if __name__ == "__main__":
    unittest.main()
