"""Whole-site owner sign-in: nothing private without a session - pages, bundles, APIs, WebSocket, HLR - plus e-mail
login, absolute (12 h) and inactivity (2 h) expiry, password change with break-glass reset, strict CSRF Origin, the
dedicated monitoring credential, and the unchanged behaviour while no owner login is configured.
TEST DATA ONLY: throw-away passwords / hashes generated here; the in-memory session store; local stand-in files."""
import asyncio
import hashlib
import json
import tempfile
import os
import time
import unittest
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from aiohttp import DummyCookieJar
from aiohttp.test_utils import TestClient, TestServer

from tluxe_gateway import app as A
from tluxe_gateway import owner_login as ol
from tluxe_gateway.app import make_app
from tluxe_gateway.auth import COOKIE, hash_password, sid_hash
from tluxe_gateway.config import ConfigError, from_env
from tluxe_gateway.store import MemoryStore, PgStore

PG_ADMIN = os.environ.get("TLUXE_TEST_DATABASE_URL", "")

PASSWORD = "Owner-test-pass 7391"
PW_HASH = hash_password(PASSWORD, n=2**12)
EMAIL = "owner@example.com"
DEV = "http://localhost:5182"
PROD = "https://tluxe.example.app"
MON_TOKEN = "monitor-token-" + "m" * 40
MON_SHA = hashlib.sha256(MON_TOKEN.encode()).hexdigest()
BRIDGE_TOKEN = "mt5-bridge-token-" + "x" * 40
HLR_PASSWORD = "hlr second layer 5521"
HLR_HASH = hash_password(HLR_PASSWORD, n=2**12)


def site(tmp: Path) -> Path:
    """A stand-in built web app: index + a hashed bundle + a public-folder file."""
    (tmp / "assets").mkdir()
    (tmp / "index.html").write_text("<!doctype html><title>dash</title><div id=root>PRIVATE-DASHBOARD</div>")
    (tmp / "assets" / "index-abc123.js").write_text("console.log('PRIVATE-ENGINE-CODE')")
    (tmp / "favicon.svg").write_text("<svg/>")
    return tmp


class OwnerCase(unittest.IsolatedAsyncioTestCase):
    env: dict = {}
    prod = False

    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = site(Path(self.tmp.name))
        base = {"TLUXE_ENV": "production", "PUBLIC_APP_URL": PROD, "ALLOWED_ORIGINS": PROD, "DATABASE_URL": "postgresql://u:dbpass123@db.internal:5432/tluxe"} \
            if self.prod else {"TLUXE_ENV": "development"}
        env = {**base, "TLUXE_OWNER_PASSWORD_HASH": PW_HASH, "TLUXE_OWNER_EMAIL": EMAIL, "TLUXE_STATIC_DIR": str(root),
               "TLUXE_MT5_BRIDGE_TOKEN_SHA256": hashlib.sha256(BRIDGE_TOKEN.encode()).hexdigest(), **self.env}
        self.cfg = from_env(env)
        self.store = await self.make_store()
        self.app = make_app(self.cfg, store=self.store, workers=False)
        # No cookie jar: every request carries exactly the cookies a test gives it (a jar would silently resend them).
        self.client = TestClient(TestServer(self.app), cookie_jar=DummyCookieJar())
        await self.client.start_server()
        self.origin = PROD if self.prod else DEV

    async def make_store(self):
        return MemoryStore()

    async def asyncTearDown(self) -> None:
        await self.client.close()
        self.tmp.cleanup()

    async def login(self, email=EMAIL, password=PASSWORD):
        return await self.client.post("/api/auth/login", json={"email": email, "password": password}, headers={"Origin": self.origin})

    async def sid(self) -> str:
        r = await self.login()
        self.assertEqual(r.status, 200, await r.text())
        return r.cookies[COOKIE].value

    def ck(self, sid: str, **h) -> dict:
        return {"Cookie": f"{COOKIE}={sid}", "Origin": self.origin, **h}

    async def get(self, path: str, **h):
        return await self.client.get(path, headers=h, allow_redirects=False)


class TestWholeSiteGate(OwnerCase):
    async def test_pages_redirect_to_login_without_a_session(self):
        for path in ("/", "/index.html", "/engines/gc-order-flow-heatmap", "/settings?x=1"):
            r = await self.get(path, Accept="text/html,application/xhtml+xml")
            self.assertEqual(r.status, 302, path)
            self.assertTrue(r.headers["Location"].startswith("/login"), r.headers["Location"])
            self.assertIn("no-store", r.headers["Cache-Control"])
            self.assertNotIn("PRIVATE", await r.text())
        loc = urlsplit((await self.get("/engines/x?y=1", Accept="text/html")).headers["Location"])
        self.assertEqual((loc.path, parse_qs(loc.query)), ("/login", {"next": ["/engines/x?y=1"]}))

    async def test_bundles_and_files_are_refused_without_a_session(self):
        for path in ("/assets/index-abc123.js", "/favicon.svg", "/assets/../index.html", "/assets/missing.js"):
            r = await self.get(path, Accept="*/*")
            self.assertIn(r.status, (401, 302), path)
            body = await r.text()
            self.assertNotIn("PRIVATE", body, path)
            self.assertIn("no-store", r.headers.get("Cache-Control", ""), path)

    async def test_signed_in_owner_gets_the_site_marked_private_for_shared_caches(self):
        sid = await self.sid()
        r = await self.get("/", **self.ck(sid), Accept="text/html")
        self.assertEqual(r.status, 200)
        self.assertIn("PRIVATE-DASHBOARD", await r.text())
        self.assertTrue(r.headers["Cache-Control"].startswith("private"))
        self.assertEqual(r.headers["Vary"], "Cookie")
        a = await self.get("/assets/index-abc123.js", **self.ck(sid))
        self.assertEqual(a.status, 200)
        self.assertEqual(a.headers["Cache-Control"], "private, max-age=31536000, immutable")  # never "public": Cloudflare keeps nothing

    async def test_login_page_is_public_self_contained_and_ships_no_dashboard_code(self):
        r = await self.get("/login", Accept="text/html")
        self.assertEqual(r.status, 200)
        html = await r.text()
        self.assertIn("Secure Sign In", html)
        self.assertIn('id="lg-email"', html)
        self.assertNotIn('"/assets/', html)  # none of the dashboard bundles
        self.assertNotIn("PRIVATE", html)
        self.assertIn("no-store", r.headers["Cache-Control"])
        for name in ("login.css", "login.js", "mark.svg"):
            self.assertEqual((await self.get(f"/login/assets/{name}")).status, 200, name)
        for name in ("..%2Fapp.py", "owner_login.py", "login.html", "x.js"):
            self.assertEqual((await self.get(f"/login/assets/{name}")).status, 404, name)
        js = await (await self.get("/login/assets/login.js")).text()
        self.assertNotIn("localStorage", js)  # nothing kept in the browser
        sid = await self.sid()
        r = await self.get("/login?next=/engines/x", **self.ck(sid))
        self.assertEqual((r.status, r.headers["Location"]), (302, "/engines/x"))
        r = await self.get("/login?next=/%09/evil.example", **self.ck(sid))
        self.assertEqual((r.status, r.headers["Location"]), (302, "/"))
        for evil in ("//evil.example", "https://evil.example", "/\\evil", "/login", "/\t/evil.example", "/\n/evil.example", "/ /evil", "/\x00x", "/" + "a" * 600):
            self.assertEqual(ol.safe_next(evil), "/", evil)

    async def test_market_data_apis_and_the_stream_need_a_session(self):
        for path in ("/api/ibkr/status", "/api/ibkr/book?root=GC", "/api/ibkr/heatmap?root=GC&from=0&to=1&bucket=60000", "/api/ibkr/history",
                     "/api/databento/status?root=GC", "/api/databento/v1/candles/GC?timeframe=M1", "/api/mt5/v1/health", "/api/mt5/v1/quote/XAUUSD",
                     "/api/status", "/api/auth/me", "/api/news/v1/health", "/api/ai/health"):
            self.assertEqual((await self.get(path, Origin=self.origin)).status, 401, path)
        with self.assertRaises(Exception):
            await self.client.ws_connect("/api/stream", headers={"Origin": self.origin})
        sid = await self.sid()
        self.assertEqual((await self.get("/api/ibkr/status", **self.ck(sid))).status, 200)
        ws = await self.client.ws_connect("/api/stream", headers=self.ck(sid))
        await ws.close()

    async def test_public_endpoints_stay_minimal(self):
        self.assertEqual(await (await self.get("/healthz")).json(), {"ok": True})
        self.assertEqual((await self.get("/readyz")).status, 200)
        c = await (await self.get("/api/config")).json()
        self.assertEqual((c["authRequired"], c["publicMarketData"]), (True, False))


class TestLogin(OwnerCase):
    async def test_email_and_password_both_required_and_same_message_for_either_wrong(self):
        self.assertEqual((await self.login()).status, 200)
        self.assertEqual((await self.login(email="OWNER@Example.com ")).status, 200)  # case / whitespace tolerant
        bad_mail, bad_pw = await self.login(email="other@example.com"), await self.login(password="nope nope nope")
        self.assertEqual((bad_mail.status, bad_pw.status), (401, 401))
        self.assertEqual(await bad_mail.json(), await bad_pw.json())
        r = await self.client.post("/api/auth/login", json={"password": PASSWORD}, headers={"Origin": self.origin})
        self.assertEqual(r.status, 400)
        self.assertTrue(any(e["kind"] == "LOGIN_FAIL" for e in self.store.auth))

    async def test_cookie_flags(self):
        r = await self.login()
        c = r.cookies[COOKIE]
        self.assertTrue(c["httponly"])
        self.assertEqual(c["samesite"], "Strict")
        self.assertEqual(c["path"], "/")

    async def test_logout_ends_the_session_everywhere_it_is_used(self):
        sid = await self.sid()
        self.assertEqual((await self.client.post("/api/auth/logout", headers=self.ck(sid))).status, 200)
        self.assertEqual((await self.get("/api/auth/me", **self.ck(sid))).status, 401)
        self.assertEqual((await self.get("/", **self.ck(sid), Accept="text/html")).status, 302)
        self.assertEqual((await self.get("/assets/index-abc123.js", **self.ck(sid))).status, 401)

    async def test_rate_limited(self):
        for _ in range(5):
            await self.login(password="wrong wrong wrong")
        r = await self.login()
        self.assertEqual(r.status, 429)


class TestHashWithoutEmailFailsClosed(OwnerCase):
    env = {"TLUXE_OWNER_EMAIL": ""}

    async def test_nobody_can_sign_in_and_the_site_stays_locked(self):
        self.assertEqual((await self.login()).status, 503)
        self.assertEqual((await self.get("/", Accept="text/html")).status, 302)
        self.assertEqual((await self.get("/api/ibkr/status")).status, 401)


class TestExpiry(OwnerCase):
    async def test_absolute_maximum_survives_rotation(self):
        sid = await self.sid()
        h = sid_hash(sid)
        old = time.time() - (self.cfg.session_ttl_s + 60)
        self.store.sessions[h].update({"auth_at": old, "expires": old + self.cfg.session_ttl_s, "active_at": time.time()})
        self.assertEqual((await self.get("/api/auth/me", **self.ck(sid))).status, 401)

    async def test_rotation_keeps_the_original_sign_in_time(self):
        sid = await self.sid()
        auth_at = time.time() - 5 * 3600
        self.store.sessions[sid_hash(sid)].update({"auth_at": auth_at, "expires": auth_at + self.cfg.session_ttl_s})
        r = await self.get("/api/auth/me", **{**self.ck(sid), "Cookie": f"{COOKIE}={sid}; {COOKIE}_iat={int(time.time()) - 7200}"})
        self.assertEqual(r.status, 200)
        new = r.cookies[COOKIE].value
        self.assertNotEqual(new, sid)
        s = self.store.sessions[sid_hash(new)]
        self.assertAlmostEqual(s["expires"], auth_at + self.cfg.session_ttl_s, delta=1)  # NOT now + 12 h
        self.assertTrue(self.store.sessions[sid_hash(sid)]["revoked"])

    async def test_inactivity_ends_the_session_and_background_polling_does_not_count(self):
        sid = await self.sid()
        s = self.store.sessions[sid_hash(sid)]
        s["active_at"] = time.time() - self.cfg.session_idle_s + 30
        for _ in range(3):  # background polling: must not move the inactivity clock
            await self.get("/api/ibkr/status", **self.ck(sid))
        self.assertLess(s["active_at"], time.time() - self.cfg.session_idle_s + 60)
        self.assertEqual((await self.client.post("/api/auth/activity", headers=self.ck(sid))).status, 200)  # real activity
        self.assertGreater(s["active_at"], time.time() - 5)
        s["active_at"] = time.time() - self.cfg.session_idle_s - 1
        self.assertEqual((await self.get("/api/ibkr/status", **self.ck(sid))).status, 401)
        self.assertEqual((await self.get("/", **self.ck(sid), Accept="text/html")).status, 302)

    async def test_an_open_stream_is_closed_when_the_session_ends(self):
        A.STREAM_RECHECK_S = 0.05
        try:
            sid = await self.sid()
            ws = await self.client.ws_connect("/api/stream", headers=self.ck(sid))
            await self.client.post("/api/auth/logout", headers=self.ck(sid))
            deadline = time.time() + 3
            while not ws.closed and time.time() < deadline:
                try:
                    await asyncio.wait_for(ws.receive(), 0.5)
                except asyncio.TimeoutError:
                    pass
            self.assertTrue(ws.closed)
            self.assertEqual(ws.close_code, 4401)
        finally:
            A.STREAM_RECHECK_S = 30

    def test_config_defaults(self):
        self.assertEqual((self.cfg.session_ttl_s, self.cfg.session_idle_s), (12 * 3600, 2 * 3600))


class TestPasswordChange(OwnerCase):
    async def change(self, sid, cur, new, origin=None):
        return await self.client.post("/api/auth/password", json={"currentPassword": cur, "newPassword": new},
                                      headers={"Cookie": f"{COOKIE}={sid}", "Origin": origin or self.origin})

    async def test_change_rotates_everything_and_only_the_new_password_works(self):
        a, b = await self.sid(), await self.sid()  # two browsers
        NEW = "Brand new owner pass 2468"
        self.assertEqual((await self.change(a, "wrong current pw", NEW)).status, 401)
        self.assertEqual((await self.change(a, PASSWORD, "short")).status, 400)
        self.assertEqual((await self.change(a, PASSWORD, PASSWORD)).status, 400)
        r = await self.change(a, PASSWORD, NEW)
        self.assertEqual(r.status, 200, await r.text())
        fresh = r.cookies[COOKIE].value
        for old in (a, b):
            self.assertEqual((await self.get("/api/auth/me", **self.ck(old))).status, 401)
        self.assertEqual((await self.get("/api/auth/me", **self.ck(fresh))).status, 200)
        self.assertEqual((await self.login()).status, 401)  # old password no longer accepted
        self.assertEqual((await self.login(password=NEW)).status, 200)
        stored = self.store.owner_credential[0]
        self.assertTrue(stored.startswith("scrypt$"))
        self.assertNotIn(NEW, json.dumps(self.store.auth) + stored)
        self.assertEqual([e["kind"] for e in self.store.auth].count("PASSWORD_CHANGED"), 1)

    async def test_break_glass_a_new_bootstrap_hash_overrides_the_stored_one(self):
        a = await self.sid()
        self.assertEqual((await self.change(a, PASSWORD, "Changed in the app 1357")).status, 200)
        rescue = "Railway reset password 8642"
        cfg2 = from_env({"TLUXE_ENV": "development", "TLUXE_OWNER_PASSWORD_HASH": hash_password(rescue, n=2**12), "TLUXE_OWNER_EMAIL": EMAIL})
        self.assertEqual(await ol.effective_hash(cfg2, self.store), cfg2.owner_password_hash.reveal())
        self.assertNotEqual(await ol.effective_hash(self.cfg, self.store), self.cfg.owner_password_hash.reveal())

    async def test_needs_a_session_and_the_app_origin(self):
        self.assertEqual((await self.client.post("/api/auth/password", json={}, headers={"Origin": self.origin})).status, 401)
        sid = await self.sid()
        self.assertEqual((await self.change(sid, PASSWORD, "Another new pass 9753", origin="https://evil.example")).status, 403)


@unittest.skipUnless(PG_ADMIN, "TLUXE_TEST_DATABASE_URL not set - production mode needs PostgreSQL (never faked)")
class TestCsrfProduction(OwnerCase):
    prod = True

    async def make_store(self):
        import psycopg

        self.dbname = f"tluxe_owner_{uuid.uuid4().hex[:10]}"
        async with await psycopg.AsyncConnection.connect(PG_ADMIN, autocommit=True) as c:
            await c.execute(f'CREATE DATABASE "{self.dbname}"')
        return PgStore(f"{PG_ADMIN.rsplit('/', 1)[0]}/{self.dbname}")

    async def asyncTearDown(self) -> None:
        import psycopg

        await super().asyncTearDown()
        async with await psycopg.AsyncConnection.connect(PG_ADMIN, autocommit=True) as c:
            await c.execute(f'DROP DATABASE IF EXISTS "{self.dbname}" WITH (FORCE)')

    async def test_state_changing_requests_need_the_exact_app_origin(self):
        r = await self.client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})  # no Origin
        self.assertEqual(r.status, 403)
        r = await self.client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD}, headers={"Origin": "https://evil.example"})
        self.assertEqual(r.status, 403)
        r = await self.client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD}, headers={"Origin": "null"})
        self.assertEqual(r.status, 403)
        sid = (await self.login()).cookies[COOKIE].value
        for path in ("/api/auth/logout", "/api/auth/password", "/api/auth/activity", "/api/alerts"):
            self.assertEqual((await self.client.post(path, json={}, headers={"Cookie": f"{COOKIE}={sid}"})).status, 403, path)
            self.assertEqual((await self.client.post(path, json={}, headers={"Cookie": f"{COOKIE}={sid}", "Origin": "https://evil.example"})).status, 403, path)
        self.assertTrue(self.cfg.cookie_secure)


class TestMonitoring(OwnerCase):
    env = {"TLUXE_MONITOR_TOKEN_SHA256": MON_SHA}

    async def test_dedicated_credential_and_no_market_data(self):
        self.assertEqual((await self.get("/api/monitor/health")).status, 401)
        self.assertEqual((await self.get("/api/monitor/health", Authorization="Bearer wrong")).status, 401)
        sid = await self.sid()
        self.assertEqual((await self.get("/api/monitor/health", **self.ck(sid))).status, 401)  # a browser session is not it
        r = await self.get("/api/monitor/health", Authorization=f"Bearer {MON_TOKEN}")
        self.assertEqual(r.status, 200)
        body = await r.json()
        self.assertEqual(set(body), {"timeMs", "databento", "ibkr", "mt5", "hlr"})
        flat = json.dumps(body).lower()
        for word in ("price", "bid", "ask", "size", "open", "high", "low", "close", "volume", "rows", "book"):
            self.assertNotIn(f'"{word}', flat, word)
        # the monitoring token opens nothing else
        for path in ("/api/ibkr/status", "/api/databento/status?root=GC", "/"):
            self.assertIn((await self.get(path, Authorization=f"Bearer {MON_TOKEN}", Accept="text/html")).status, (401, 302), path)

    async def test_rate_limited_per_client(self):
        codes = [(await self.get("/api/monitor/health", Authorization="Bearer wrong")).status for _ in range(12)]
        self.assertEqual(codes[:10], [401] * 10)
        self.assertEqual(codes[-1], 429)
        self.assertLessEqual(sum(e["kind"] == "MONITOR_REJECTED" for e in self.store.auth), 10)  # audit rows stay bounded

    async def test_absent_without_a_configured_token(self):
        cfg = from_env({"TLUXE_ENV": "development", "TLUXE_OWNER_PASSWORD_HASH": PW_HASH, "TLUXE_OWNER_EMAIL": EMAIL})
        self.assertEqual(cfg.monitor_keys, ())
        with self.assertRaises(ConfigError):
            from_env({"TLUXE_ENV": "development", "TLUXE_MONITOR_TOKEN_SHA256": "not-a-hash"})


class TestBridgesUntouched(OwnerCase):
    async def test_vps_bridge_links_use_their_own_keys_not_the_owner_login(self):
        ws = await self.client.ws_connect("/bridge/mt5", headers={"Authorization": f"Bearer {BRIDGE_TOKEN}", "X-TLUXE-Bridge-Id": "vps-test"})
        self.assertFalse(ws.closed)
        await ws.close()
        r = await self.get("/bridge/mt5", Authorization="Bearer wrong")
        self.assertEqual(r.status, 401)


class TestHlrTwoLayers(OwnerCase):
    env = {"TLUXE_HLR_PASSWORD_HASH": HLR_HASH}

    async def asyncSetUp(self) -> None:
        self.hlrdir = tempfile.TemporaryDirectory()
        (Path(self.hlrdir.name) / "hlr.html").write_text("<!doctype html><title>hlr</title>HLR-PRIVATE")
        self.env = {**self.env, "TLUXE_HLR_FILES_DIR": self.hlrdir.name}
        await super().asyncSetUp()

    async def asyncTearDown(self) -> None:
        await super().asyncTearDown()
        self.hlrdir.cleanup()

    async def test_owner_login_first_then_the_hlr_password(self):
        r = await self.get("/hlr-original/hlr.html", Accept="text/html")
        self.assertEqual(r.status, 302)  # layer 1: owner sign-in
        self.assertTrue(r.headers["Location"].startswith("/login"))
        self.assertEqual((await self.client.post("/api/hlr/auth/login", json={"password": HLR_PASSWORD}, headers={"Origin": self.origin})).status, 401)
        sid = await self.sid()
        r = await self.get("/hlr-original/hlr.html", **self.ck(sid), Accept="text/html")
        self.assertEqual(r.status, 401)  # layer 2: the HLR credential is still required
        self.assertNotIn("HLR-PRIVATE", await r.text())
        r = await self.client.post("/api/hlr/auth/login", json={"password": HLR_PASSWORD}, headers=self.ck(sid))
        self.assertEqual(r.status, 200, await r.text())
        hlr_cookie = r.cookies["tluxe_hlr"].value
        both = {"Cookie": f"{COOKIE}={sid}; tluxe_hlr={hlr_cookie}", "Origin": self.origin, "Accept": "text/html"}
        r = await self.client.get("/hlr-original/hlr.html", headers=both, allow_redirects=False)
        self.assertEqual(r.status, 200)
        self.assertIn("HLR-PRIVATE", await r.text())
        # the HLR session alone (owner signed out) opens nothing
        await self.client.post("/api/auth/logout", headers=self.ck(sid))
        r = await self.client.get("/hlr-original/hlr.html", headers={"Cookie": f"tluxe_hlr={hlr_cookie}", "Accept": "text/html"}, allow_redirects=False)
        self.assertEqual(r.status, 302)


class TestPublicModeUnchanged(unittest.IsolatedAsyncioTestCase):
    """No owner hash (today's production): the site is served exactly as before - nothing new is gated."""

    async def test_unchanged(self):
        with tempfile.TemporaryDirectory() as d:
            root = site(Path(d))
            cfg = from_env({"TLUXE_ENV": "development", "TLUXE_STATIC_DIR": str(root)})
            self.assertTrue(cfg.public_market_data)
            client = TestClient(TestServer(make_app(cfg, store=MemoryStore(), workers=False)))
            await client.start_server()
            try:
                r = await client.get("/", headers={"Accept": "text/html"}, allow_redirects=False)
                self.assertEqual(r.status, 200)
                a = await client.get("/assets/index-abc123.js")
                self.assertEqual(a.headers["Cache-Control"], "public, max-age=31536000, immutable")
                self.assertEqual((await client.get("/login", allow_redirects=False)).status, 200)  # the SPA catch-all, as before
                self.assertEqual((await client.get("/api/ibkr/status")).status, 200)
            finally:
                await client.close()


if __name__ == "__main__":
    unittest.main()
