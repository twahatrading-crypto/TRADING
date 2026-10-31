"""GC HLR producer credential: TLUXE_GC_HLR_TOKEN_SHA256 opens exactly GET /api/databento/v1/candles/GC.
Valid / missing / invalid / expired / revoked / rotated tokens, the scope (nothing else opens), owner login ON and OFF,
and the token never reaching the upstream, a log line or the audit trail.
TEST DATA ONLY: throw-away tokens and hashes; a stand-in Databento service on loopback; the in-memory store
(plus PostgreSQL for the audit constraint when TLUXE_TEST_DATABASE_URL is set)."""
import hashlib
import tempfile
import json
import os
import time
import unittest
import uuid

from aiohttp import DummyCookieJar, web
from aiohttp.test_utils import TestClient, TestServer

from tluxe_gateway.app import make_app
from tluxe_gateway.auth import COOKIE, hash_password
from tluxe_gateway.config import ConfigError, from_env
from tluxe_gateway.store import MemoryStore, PgStore

PG_ADMIN = os.environ.get("TLUXE_TEST_DATABASE_URL", "")
PASSWORD = "Owner-test-pass 7391"
PW_HASH = hash_password(PASSWORD, n=2**12)
EMAIL = "owner@example.com"
DEV = "http://localhost:5182"
DB_TOKEN = "databento-bridge-token-" + "d" * 32
GC_TOKEN = "gc-hlr-test-token-" + "g" * 40
GC_TOKEN_2 = "gc-hlr-rotated-token-" + "r" * 40
sha = lambda t: hashlib.sha256(t.encode()).hexdigest()  # noqa: E731


def fake_databento(seen: list):
    """Stand-in Databento bridge: answers only with the GATEWAY's own bridge token, records what reached it."""
    async def handler(request: web.Request):
        seen.append({"path": request.path, "qs": request.query_string, "auth": request.headers.get("Authorization", "")})
        if request.headers.get("Authorization") != f"Bearer {DB_TOKEN}":
            return web.json_response({"error": "bad bridge token"}, status=401)
        return web.json_response({"root": request.path.rsplit("/", 1)[-1], "bars": [{"t": 1, "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 3}]})

    app = web.Application()
    for p in ("/v1/candles/GC", "/v1/candles/SI", "/v1/feed", "/v1/health", "/v1/book/GC", "/v1/trades/GC"):
        app.router.add_get(p, handler)
    return app


class GcHlrCase(unittest.IsolatedAsyncioTestCase):
    owner_login = True
    keys = sha(GC_TOKEN)

    async def make_store(self):
        return MemoryStore()

    async def asyncSetUp(self) -> None:
        self.seen: list = []
        self.site = tempfile.TemporaryDirectory()
        with open(os.path.join(self.site.name, "index.html"), "w") as f:
            f.write("<!doctype html><title>dash</title>PRIVATE-DASHBOARD")
        self.up = TestServer(fake_databento(self.seen))
        await self.up.start_server()
        env = {"TLUXE_ENV": "development", "TLUXE_DATABENTO_URL": f"http://127.0.0.1:{self.up.port}", "TLUXE_DB_BRIDGE_TOKEN": DB_TOKEN,
               "TLUXE_STATIC_DIR": self.site.name}
        if self.owner_login:
            env.update({"TLUXE_OWNER_PASSWORD_HASH": PW_HASH, "TLUXE_OWNER_EMAIL": EMAIL})
        if self.keys:
            env["TLUXE_GC_HLR_TOKEN_SHA256"] = self.keys
        env.update(self.extra_env())
        self.cfg = from_env(env)
        self.store = await self.make_store()
        self.client = TestClient(TestServer(make_app(self.cfg, store=self.store, workers=False)), cookie_jar=DummyCookieJar())
        await self.client.start_server()

    def extra_env(self) -> dict:
        return {}

    async def asyncTearDown(self) -> None:
        await self.client.close()
        await self.up.close()
        self.site.cleanup()

    async def get(self, path: str, token: str | None = None, **h):
        if token is not None:
            h["Authorization"] = f"Bearer {token}"
        return await self.client.get(path, headers=h, allow_redirects=False)

    CANDLES = "/api/databento/v1/candles/GC?timeframe=M1&limit=400"


class TestLoginOn(GcHlrCase):
    async def test_valid_token_reads_gc_candles_and_never_reaches_upstream_or_logs(self):
        with self.assertLogs("tluxe", level="DEBUG") as logs:
            r = await self.get(self.CANDLES, GC_TOKEN)
            await self.get(self.CANDLES, "wrong-token-" + "w" * 40)  # make sure something is logged at all
        self.assertEqual(r.status, 200, await r.text())
        body = await r.json()
        self.assertEqual(body["root"], "GC")
        self.assertEqual(self.seen[-1]["path"], "/v1/candles/GC")
        self.assertEqual(self.seen[-1]["qs"], "timeframe=M1&limit=400")  # timeframe and limit pass through
        self.assertTrue(all(s["auth"] == f"Bearer {DB_TOKEN}" for s in self.seen))  # the gateway's own token upstream
        everything = "\n".join(logs.output) + json.dumps(self.store.auth) + json.dumps(self.seen)
        self.assertNotIn(GC_TOKEN, everything)
        self.assertNotIn("wrong-token-", everything)
        self.assertEqual(r.headers.get("Cache-Control"), "no-store")

    async def test_missing_credential_is_refused(self):
        self.assertEqual((await self.get(self.CANDLES)).status, 401)
        self.assertEqual(self.seen, [])

    async def test_invalid_credentials_are_refused_and_audited(self):
        for auth in ("Bearer wrong", "Bearer ", "Basic " + GC_TOKEN, GC_TOKEN, "bearer " + GC_TOKEN):
            r = await self.client.get(self.CANDLES, headers={"Authorization": auth})
            self.assertEqual(r.status, 401, auth[:12])
        self.assertEqual(self.seen, [])
        rejected = [e for e in self.store.auth if e["kind"] == "GC_HLR_REJECTED"]
        self.assertEqual(len(rejected), 5)
        self.assertNotIn(GC_TOKEN, json.dumps(rejected))

    async def test_the_credential_opens_nothing_else(self):
        for path, want in (("/api/databento/v1/candles/SI?timeframe=M1", 403), ("/api/databento/v1/feed?cursor=0&roots=GC", 403),
                           ("/api/databento/v1/book/GC", 403), ("/api/databento/v1/trades/GC", 403), ("/api/databento/v1/health", 403),
                           ("/api/databento/v1/candles/GC/../SI", 403), ("/api/databento/status?root=GC", 401),
                           ("/api/ibkr/status", 401), ("/api/ibkr/book?root=GC", 401), ("/api/status", 401), ("/api/auth/me", 401),
                           ("/api/mt5/v1/health", 401), ("/api/news/v1/health", 401), ("/api/ai/health", 401),
                           ("/hlr-original/hlr.html", 401), ("/api/monitor/health", 404)):
            r = await self.get(path, GC_TOKEN, Accept="application/json")
            self.assertIn(r.status, (want, 404) if want == 401 and path.startswith("/hlr") else (want,), path)
        r = await self.get("/", GC_TOKEN, Accept="text/html")
        self.assertEqual(r.status, 302)
        self.assertNotIn("PRIVATE", await r.text())
        # read-only: a write method is refused before it can reach Databento (405, or the API catch-all's 404)
        self.assertIn((await self.client.post(self.CANDLES, headers={"Authorization": f"Bearer {GC_TOKEN}"})).status, (404, 405))
        with self.assertRaises(Exception):
            await self.client.ws_connect("/api/stream", headers={"Authorization": f"Bearer {GC_TOKEN}"})
        self.assertTrue(all(s["path"] == "/v1/candles/GC" for s in self.seen))  # only GC candles were ever fetched

    async def test_browser_owner_session_is_unchanged(self):
        r = await self.client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD}, headers={"Origin": DEV})
        sid = r.cookies[COOKIE].value
        ck = {"Cookie": f"{COOKIE}={sid}"}
        self.assertEqual((await self.client.get(self.CANDLES, headers=ck)).status, 200)
        self.assertEqual((await self.client.get("/api/databento/v1/candles/SI", headers=ck)).status, 200)
        # a session never makes a bad machine credential acceptable
        self.assertEqual((await self.client.get(self.CANDLES, headers={**ck, "Authorization": "Bearer wrong"})).status, 401)

    async def test_rate_limited_per_client(self):
        codes = [(await self.get(self.CANDLES, "x" * 40)).status for _ in range(45)]
        self.assertEqual(codes[:40], [401] * 40)
        self.assertEqual(codes[-1], 429)
        self.assertLessEqual(sum(e["kind"] == "GC_HLR_REJECTED" for e in self.store.auth), 40)


class TestNoKeyConfiguredFailsClosed(GcHlrCase):
    keys = ""

    async def test_any_token_is_refused(self):
        self.assertEqual(self.cfg.gc_hlr_keys, ())
        self.assertEqual((await self.get(self.CANDLES, GC_TOKEN)).status, 401)
        self.assertEqual(self.seen, [])


class TestExpiredKeyIsRevoked(GcHlrCase):
    keys = f"{sha(GC_TOKEN)}@{int(time.time()) - 60}"

    async def test_expired(self):
        self.assertEqual((await self.get(self.CANDLES, GC_TOKEN)).status, 401)


class TestRotation(GcHlrCase):
    keys = f"{sha(GC_TOKEN_2)},{sha(GC_TOKEN)}@{int(time.time()) + 3600}"

    async def test_old_and_new_both_work_during_rotation(self):
        self.assertEqual((await self.get(self.CANDLES, GC_TOKEN)).status, 200)
        self.assertEqual((await self.get(self.CANDLES, GC_TOKEN_2)).status, 200)


class TestRevokedByRemoval(GcHlrCase):
    keys = sha(GC_TOKEN_2)  # GC_TOKEN removed from the list

    async def test_removed_token_is_refused(self):
        self.assertEqual((await self.get(self.CANDLES, GC_TOKEN)).status, 401)
        self.assertEqual((await self.get(self.CANDLES, GC_TOKEN_2)).status, 200)


class TestLoginOff(GcHlrCase):
    """Today's public mode: anonymous reads are unchanged; a PRESENTED credential is still checked (fail closed)."""
    owner_login = False

    async def test_public_mode(self):
        self.assertTrue(self.cfg.public_market_data)
        self.assertEqual((await self.get(self.CANDLES)).status, 200)  # unchanged public behaviour
        self.assertEqual((await self.get(self.CANDLES, GC_TOKEN)).status, 200)
        self.assertEqual((await self.get(self.CANDLES, "wrong-" + "w" * 40)).status, 401)
        self.assertEqual((await self.get("/api/databento/v1/candles/SI", GC_TOKEN)).status, 403)
        self.assertEqual((await self.get("/api/databento/v1/candles/SI")).status, 200)  # anonymous public read as before


class TestConfig(unittest.TestCase):
    def test_validation(self):
        with self.assertRaises(ConfigError):
            from_env({"TLUXE_ENV": "development", "TLUXE_GC_HLR_TOKEN_SHA256": "not-a-hash"})
        with self.assertRaises(ConfigError):
            from_env({"TLUXE_ENV": "development", "TLUXE_GC_HLR_TOKEN_SHA256": GC_TOKEN})  # the token itself is refused
        cfg = from_env({"TLUXE_ENV": "development", "TLUXE_GC_HLR_TOKEN_SHA256": sha(GC_TOKEN).upper()})
        self.assertEqual(cfg.gc_hlr_keys[0].sha256, sha(GC_TOKEN))
        self.assertNotIn(GC_TOKEN, repr(cfg))


@unittest.skipUnless(PG_ADMIN, "TLUXE_TEST_DATABASE_URL not set - the audit constraint needs PostgreSQL (never faked)")
class TestAuditOnPostgres(GcHlrCase):
    async def make_store(self):
        import psycopg

        self.dbname = f"tluxe_gchlr_{uuid.uuid4().hex[:10]}"
        async with await psycopg.AsyncConnection.connect(PG_ADMIN, autocommit=True) as c:
            await c.execute(f'CREATE DATABASE "{self.dbname}"')
        return PgStore(f"{PG_ADMIN.rsplit('/', 1)[0]}/{self.dbname}")

    async def asyncTearDown(self) -> None:
        import psycopg

        await super().asyncTearDown()
        async with await psycopg.AsyncConnection.connect(PG_ADMIN, autocommit=True) as c:
            await c.execute(f'DROP DATABASE IF EXISTS "{self.dbname}" WITH (FORCE)')

    async def test_rejection_is_recorded_by_the_migrated_schema(self):
        self.assertEqual((await self.get(self.CANDLES, "wrong-" + "w" * 40)).status, 401)  # INSERT passes the CHECK
        self.assertEqual((await self.get(self.CANDLES, GC_TOKEN)).status, 200)
        async with self.store.pool.connection() as conn:
            cur = await conn.execute("SELECT count(*), max(detail) FROM auth_events WHERE kind = 'GC_HLR_REJECTED'")
            n, detail = await cur.fetchone()
        self.assertEqual(n, 1)
        self.assertNotIn("wrong-", detail or "")


if __name__ == "__main__":
    unittest.main()
