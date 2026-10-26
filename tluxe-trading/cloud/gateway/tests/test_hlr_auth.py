"""Isolated HLR authentication: separate credential, separate sessions, and the rest of the site
untouched.

The property under test is not "is there a login" but "can anything reach the strategy without the
HLR credential, and can this feature change how the existing site behaves". Both answers must be no.

TEST DATA ONLY: a throwaway static directory with stand-in files; nothing contacts MT5, IBKR or the
network, and no real HLR source is read.
"""
import json
import tempfile
import unittest
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

from tluxe_gateway.app import make_app
from tluxe_gateway.auth import COOKIE, hash_password
from tluxe_gateway.config import ConfigError, from_env
from tluxe_gateway.hlr_auth import HLR_COOKIE, DualLimiter, hlr_session_key, password_fingerprint
from tluxe_gateway.hlr_page import HLR_DOC_PATH
from tluxe_gateway.store import MemoryStore

HLR_PASSWORD = "hlr page password 42"
HLR_HASH = hash_password(HLR_PASSWORD, n=2**12)
OTHER_HASH = hash_password("a different password", n=2**12)
OWNER_PASSWORD = "owner password 42"
OWNER_HASH = hash_password(OWNER_PASSWORD, n=2**12)
ORIGIN = "http://localhost:5182"

DOC = b"<!doctype html><title>HLR</title><script src=\"hlr-engine.js\"></script>\n"
ENGINE = b"/* HIGH / LOW REVERSAL - engine. */ var HLR = {};\n"

BYPASS = [
    "/hlr-original/hlr-engine.js",
    "/hlr-original/hlr.html",
    "/hlr-original/index.html",
    "/assets/../hlr-original/hlr-engine.js",
    "/a/b/../../hlr-original/hlr-engine.js",
    "/./hlr-original/hlr-engine.js",
    "/hlr-original%2Fhlr-engine.js",
    "/hlr-original/deploy/runner/host.js",
]


def env(**over):
    # No TLUXE_OWNER_PASSWORD_HASH: the site stays publicly accessible, exactly as the owner requires.
    return {"TLUXE_ENV": "development", "TLUXE_HLR_PASSWORD_HASH": HLR_HASH, **over}


def private_dir(static_root) -> str:
    return str(Path(static_root).parent / "private" / "hlr-original")


def static_dir(tmp: str) -> Path:
    """Lays out a temp tree shaped like the container: a public static root, and a PRIVATE
    sibling holding the dashboard - the way the Railway volume is mounted."""
    root = Path(tmp) / "web"
    root.mkdir()
    (root / "index.html").write_bytes(b"<!doctype html><title>TLUXE</title>")
    (root / "assets").mkdir()
    (root / "assets" / "index-abc.js").write_bytes(b"console.log('public bundle');\n")
    # The dashboard lives OUTSIDE the static root - a private directory, as on Railway.
    hlr = root.parent / "private" / "hlr-original"
    hlr.mkdir(parents=True, exist_ok=True)
    for page in ("hlr.html", "index.html", "vpr.html", "sweep.html"):
        (hlr / page).write_bytes(DOC)
    (hlr / "hlr-engine.js").write_bytes(ENGINE)
    (hlr / "deploy" / "runner").mkdir(parents=True)
    (hlr / "deploy" / "runner" / "host.js").write_bytes(b"// nested\n")
    return root


class TestKeys(unittest.TestCase):
    """Session-key derivation: the isolation and the rotation behaviour live here."""

    def test_hlr_and_owner_session_spaces_cannot_collide(self):
        sid = "some-session-id"
        from tluxe_gateway.auth import sid_hash
        self.assertNotEqual(hlr_session_key(sid, HLR_HASH), sid_hash(sid))

    def test_rotating_the_password_changes_every_session_key(self):
        sid = "some-session-id"
        self.assertNotEqual(hlr_session_key(sid, HLR_HASH), hlr_session_key(sid, OTHER_HASH))

    def test_fingerprint_does_not_reveal_the_hash(self):
        fp = password_fingerprint(HLR_HASH)
        self.assertEqual(len(fp), 16)
        self.assertNotIn(fp, HLR_HASH)


class TestDualLimiter(unittest.TestCase):
    """A spoofable header may only ADD restriction - never lift one."""

    class Req:
        def __init__(self, xff=None, cf=None, remote="10.0.0.1"):
            self.headers = {}
            if xff:
                self.headers["X-Forwarded-For"] = xff
            if cf:
                self.headers["CF-Connecting-IP"] = cf
            self.remote = remote

    def test_a_forged_cf_header_cannot_escape_the_unforgeable_lockout(self):
        lim = DualLimiter()
        for i in range(25):  # lock the peer bucket while rotating the claimed one
            lim.fail(self.Req(xff="1.2.3.4, 172.16.0.9", cf=f"9.9.9.{i}"))
        self.assertGreater(lim.locked(self.Req(xff="1.2.3.4, 172.16.0.9", cf="9.9.9.250")), 0)

    def test_one_abusive_caller_locks_its_own_claimed_bucket(self):
        lim = DualLimiter()
        for _ in range(25):
            lim.fail(self.Req(xff="1.2.3.4, 172.16.0.9", cf="203.0.113.7"))
        self.assertGreater(lim.locked(self.Req(xff="5.5.5.5, 172.16.0.9", cf="203.0.113.7")), 0)

    def test_the_peer_hop_is_taken_from_the_proxy_not_the_client(self):
        peer, cf = DualLimiter.keys(self.Req(xff="1.2.3.4, 172.16.0.9", cf="203.0.113.7"))
        self.assertEqual(peer, "172.16.0.9")  # the last hop: what Railway's proxy saw
        self.assertEqual(cf, "203.0.113.7")


class TestHlrAuth(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = static_dir(self.tmp.name)
        self.cfg = from_env(env(TLUXE_STATIC_DIR=str(self.root), TLUXE_HLR_FILES_DIR=private_dir(self.root)))
        self.store = MemoryStore()
        self.client = TestClient(TestServer(make_app(self.cfg, store=self.store, workers=False)))
        await self.client.start_server()

    async def asyncTearDown(self) -> None:
        await self.client.close()
        self.tmp.cleanup()

    async def login(self, password=HLR_PASSWORD):
        return await self.client.post("/api/hlr/auth/login", json={"password": password},
                                      headers={"Origin": ORIGIN})

    # ------------------------------------------------------- the existing site is untouched

    async def test_the_rest_of_the_site_stays_public(self):
        cfg = self.cfg
        self.assertTrue(cfg.public_market_data)          # owner password still unset
        r = await self.client.get("/api/config")
        body = await r.json()
        self.assertFalse(body["authRequired"])           # main.tsx will NOT render its sign-in
        self.assertTrue(body["publicMarketData"])
        for path, needle in (("/", b"TLUXE"), ("/assets/index-abc.js", b"public bundle"),
                             ("/healthz", b"ok"), ("/engines/high-low-reversal", b"TLUXE")):
            got = await self.client.get(path)
            self.assertEqual(got.status, 200, path)
            self.assertIn(needle, await got.read(), path)

    async def test_api_config_says_nothing_about_hlr(self):
        body = await (await self.client.get("/api/config")).json()
        self.assertNotIn("hlr", " ".join(body.keys()).lower())

    # ------------------------------------------------------- the gate

    async def test_anonymous_cannot_reach_any_protected_file_by_any_path(self):
        for path in BYPASS:
            r = await self.client.get(path, allow_redirects=False)
            body = await r.read()
            self.assertIn(r.status, (401, 404), f"{path} -> {r.status}")
            self.assertNotIn(b"HIGH / LOW REVERSAL", body, f"strategy leaked via {path}")
            self.assertNotIn(b"var HLR", body, f"strategy leaked via {path}")
            self.assertNotEqual(body, DOC, f"document leaked via {path}")

    async def test_anonymous_cannot_reach_the_hlr_apis(self):
        # With no bridge token configured the relay routes do not exist at all (404) - the two
        # switches are independent: the password says who may look, the token whether data flows.
        self.assertEqual((await self.client.get("/api/hlr/auth/me")).status, 401)
        for path in ("/api/hlr/status", "/api/hlr/mt5/api/status", "/api/hlr/gc/api/snapshot"):
            self.assertEqual((await self.client.get(path)).status, 404, path)

    async def test_with_the_relay_configured_its_routes_are_gated_not_open(self):
        import hashlib
        tmp = tempfile.TemporaryDirectory()
        root = static_dir(tmp.name)
        token_sha = hashlib.sha256(("hlr-token-" + "z" * 40).encode()).hexdigest()
        cfg = from_env(env(TLUXE_STATIC_DIR=str(root), TLUXE_HLR_FILES_DIR=private_dir(root), TLUXE_HLR_BRIDGE_TOKEN_SHA256=token_sha))
        client = TestClient(TestServer(make_app(cfg, store=MemoryStore(), workers=False)))
        await client.start_server()
        try:
            for path in ("/api/hlr/status", "/api/hlr/mt5/api/status", "/api/hlr/gc/api/snapshot"):
                r = await client.get(path)
                self.assertEqual(r.status, 401, path)           # exists, but closed
                self.assertNotIn(b"MetaQuotes", await r.read(), path)
            # ...and open once this page's own credential is presented.
            self.assertEqual((await client.post("/api/hlr/auth/login", json={"password": HLR_PASSWORD},
                                                headers={"Origin": ORIGIN})).status, 200)
            self.assertEqual((await client.get("/api/hlr/status")).status, 200)
        finally:
            await client.close()
            tmp.cleanup()

    async def test_wrong_password_is_refused_and_right_one_works(self):
        self.assertEqual((await self.login("wrong")).status, 401)
        self.assertEqual((await self.login()).status, 200)
        self.assertEqual((await self.client.get("/api/hlr/auth/me")).status, 200)

    async def test_signed_in_owner_gets_the_files_byte_for_byte(self):
        await self.login()
        for path, expected in (("/hlr-original/hlr-engine.js", ENGINE),):
            r = await self.client.get(path)
            self.assertEqual(r.status, 200, path)
            self.assertEqual(await r.read(), expected, path)

    async def test_cookie_is_httponly_strict_and_distinct_from_the_owner_cookie(self):
        r = await self.login()
        raw = r.headers.getall("Set-Cookie")
        hlr = [c for c in raw if c.startswith(f"{HLR_COOKIE}=")]
        self.assertTrue(hlr, raw)
        self.assertIn("HttpOnly", hlr[0])
        self.assertIn("SameSite=Strict", hlr[0])
        self.assertFalse([c for c in raw if c.startswith(f"{COOKIE}=")])  # never touches the owner cookie

    # ------------------------------------------------------- isolation, both directions

    async def test_an_owner_session_cannot_open_the_hlr_page(self):
        """Even with a valid owner session, the HLR files stay closed."""
        tmp = tempfile.TemporaryDirectory()
        root = static_dir(tmp.name)
        cfg = from_env({"TLUXE_ENV": "development", "TLUXE_OWNER_PASSWORD_HASH": OWNER_HASH,
                        "TLUXE_HLR_PASSWORD_HASH": HLR_HASH, "TLUXE_STATIC_DIR": str(root), "TLUXE_HLR_FILES_DIR": private_dir(root), "TLUXE_HLR_FILES_DIR": private_dir(root)})
        client = TestClient(TestServer(make_app(cfg, store=MemoryStore(), workers=False)))
        await client.start_server()
        try:
            self.assertEqual((await client.post("/api/auth/login", json={"password": OWNER_PASSWORD},
                                                headers={"Origin": ORIGIN})).status, 200)
            self.assertEqual((await client.get("/api/auth/me")).status, 200)      # owner session is real
            r = await client.get("/hlr-original/hlr-engine.js")
            self.assertEqual(r.status, 401)                                        # ...and useless here
            self.assertNotIn(b"HIGH / LOW REVERSAL", await r.read())
            self.assertEqual((await client.get("/api/hlr/auth/me")).status, 401)
        finally:
            await client.close()
            tmp.cleanup()

    async def test_an_hlr_session_cannot_open_owner_routes(self):
        await self.login()
        # /api/status is owner-gated; the HLR cookie must not satisfy it.
        self.assertEqual((await self.client.get("/api/status")).status, 401)

    # ------------------------------------------------------- the private directory

    async def test_the_public_static_handler_cannot_reach_the_private_directory(self):
        """The dashboard is outside the static root, so no spelling of a static URL can escape into
        it - the strategy is not merely gated, it is not under the public tree at all."""
        for path in ("/private/hlr-original/hlr-engine.js",
                     "/../private/hlr-original/hlr-engine.js",
                     "/assets/../../private/hlr-original/hlr-engine.js",
                     "/%2e%2e/private/hlr-original/hlr-engine.js"):
            r = await self.client.get(path, allow_redirects=False)
            body = await r.read()
            self.assertNotIn(b"HIGH / LOW REVERSAL", body, path)
            self.assertNotIn(b"var HLR", body, path)

    async def test_files_endpoint_reports_presence_and_readability_only(self):
        await self.login()
        r = await self.client.get("/api/hlr/files")
        self.assertEqual(r.status, 200)
        b = await r.json()
        self.assertTrue(b["exists"])
        self.assertTrue(b["readable"])      # this process (uid 10001 in the container) can read it
        self.assertTrue(b["entry"])         # hlr.html is present and readable
        self.assertGreater(b["files"], 0)
        # Diagnostics for the volume-permission question: reported, never assumed.
        for k in ("writable", "uid", "gid", "mode", "processUid"):
            self.assertIn(k, b)
        # Presence and a count - never a file name, never contents.
        self.assertNotIn("HIGH / LOW REVERSAL", json.dumps(b))
        self.assertNotIn("hlr-engine.js", json.dumps(b))

    async def test_files_endpoint_needs_the_hlr_session(self):
        self.assertEqual((await self.client.get("/api/hlr/files")).status, 401)

    async def test_a_missing_private_volume_is_reported_not_faked(self):
        tmp = tempfile.TemporaryDirectory()
        root = static_dir(tmp.name)
        cfg = from_env(env(TLUXE_STATIC_DIR=str(root),
                           TLUXE_HLR_FILES_DIR=str(Path(tmp.name) / "not-mounted")))
        client = TestClient(TestServer(make_app(cfg, store=MemoryStore(), workers=False)))
        await client.start_server()
        try:
            await client.post("/api/hlr/auth/login", json={"password": HLR_PASSWORD},
                              headers={"Origin": ORIGIN})
            b = await (await client.get("/api/hlr/files")).json()
            self.assertFalse(b["exists"])
            self.assertEqual(b["files"], 0)
            # ...and the page answers a clean 404 rather than pretending.
            self.assertEqual((await client.get("/hlr-original/hlr.html")).status, 404)
        finally:
            await client.close()
            tmp.cleanup()

    # ------------------------------------------- framing of ERROR responses (ERR_BLOCKED_BY_RESPONSE)

    async def test_a_401_from_the_hlr_route_is_still_frameable(self):
        """A response the browser refuses to render in the iframe shows the viewer a blank frame and
        no reason. The 401 stays a 401 - only its framing headers change."""
        r = await self.client.get(f"/{HLR_DOC_PATH}")
        self.assertEqual(r.status, 401)
        self.assertEqual(r.headers["X-Frame-Options"], "SAMEORIGIN")
        self.assertIn("frame-ancestors 'self'", r.headers["Content-Security-Policy"])
        self.assertNotIn(b"HIGH / LOW REVERSAL", await r.read())

    async def test_a_404_for_a_missing_dashboard_is_still_frameable(self):
        """Exactly the production state after the password is set but before the upload."""
        tmp = tempfile.TemporaryDirectory()
        root = static_dir(tmp.name)
        (Path(root).parent / "private" / "hlr-original" / "hlr.html").unlink()
        cfg = from_env(env(TLUXE_STATIC_DIR=str(root), TLUXE_HLR_FILES_DIR=private_dir(root)))
        client = TestClient(TestServer(make_app(cfg, store=MemoryStore(), workers=False)))
        await client.start_server()
        try:
            await client.post("/api/hlr/auth/login", json={"password": HLR_PASSWORD},
                              headers={"Origin": ORIGIN})
            r = await client.get(f"/{HLR_DOC_PATH}")
            self.assertEqual(r.status, 404)
            self.assertEqual(r.headers["X-Frame-Options"], "SAMEORIGIN")
            self.assertIn("frame-ancestors 'self'", r.headers["Content-Security-Policy"])
            self.assertIn(b"have not been uploaded", await r.read())
        finally:
            await client.close()
            tmp.cleanup()

    async def test_the_rest_of_the_site_still_denies_framing_entirely(self):
        """The relaxation must not have leaked anywhere else."""
        await self.login()
        for path in ("/", "/index.html", "/api/config", "/assets/index-abc.js",
                     "/api/hlr/auth/me", "/api/hlr/files"):
            r = await self.client.get(path)
            self.assertEqual(r.headers["X-Frame-Options"], "DENY", path)
            self.assertIn("frame-ancestors 'none'", r.headers["Content-Security-Policy"], path)

    # ------------------------------------------------------- PUBLIC mode

    async def test_public_mode_serves_the_dashboard_to_anyone(self):
        """TLUXE_HLR_PUBLIC=1: no password, no sign-in, open to every visitor. This is the owner's
        deliberate choice to publish the strategy; the test states exactly what it means."""
        tmp = tempfile.TemporaryDirectory()
        root = static_dir(tmp.name)
        cfg = from_env({"TLUXE_ENV": "development", "TLUXE_HLR_PUBLIC": "1",
                        "TLUXE_STATIC_DIR": str(root), "TLUXE_HLR_FILES_DIR": private_dir(root)})
        self.assertTrue(cfg.hlr_public)
        client = TestClient(TestServer(make_app(cfg, store=MemoryStore(), workers=False)))
        await client.start_server()
        try:
            # No cookie at all - a random visitor.
            r = await client.get("/hlr-original/hlr-engine.js")
            self.assertEqual(r.status, 200)
            self.assertIn(b"HIGH / LOW REVERSAL", await r.read())   # the strategy IS public now
            self.assertEqual((await client.get(f"/{HLR_DOC_PATH}")).status, 200)
            # /api/hlr/files answers, but tells an anonymous caller ONLY whether the dashboard is
            # there - no mount path, no uid/gid/mode, no file count, no writability. Publishing the
            # strategy is the owner's choice; publishing the host's internals is not part of it.
            fr = await client.get("/api/hlr/files")
            self.assertEqual(fr.status, 200)
            body = await fr.json()
            self.assertEqual(set(body), {"entry"})
            for leak in ("dir", "uid", "gid", "mode", "processUid", "files", "writable"):
                self.assertNotIn(leak, body)
            # ...and there is nothing to sign in to.
            self.assertEqual((await client.get("/api/hlr/auth/me")).status, 404)
            self.assertEqual((await client.post("/api/hlr/auth/login",
                                                json={"password": HLR_PASSWORD},
                                                headers={"Origin": ORIGIN})).status, 404)
            # The rest of the site is still untouched.
            self.assertEqual((await client.get("/")).status, 200)
            cfgd = await (await client.get("/api/config")).json()
            self.assertFalse(cfgd["authRequired"])
            self.assertTrue(cfgd["publicMarketData"])
        finally:
            await client.close()
            tmp.cleanup()

    async def test_public_mode_still_refuses_orders_and_email(self):
        """Opening the page does not open anything else: the write paths stay refused."""
        tmp = tempfile.TemporaryDirectory()
        root = static_dir(tmp.name)
        import hashlib
        tok = hashlib.sha256(("t" * 48).encode()).hexdigest()
        cfg = from_env({"TLUXE_ENV": "development", "TLUXE_HLR_PUBLIC": "1",
                        "TLUXE_STATIC_DIR": str(root), "TLUXE_HLR_FILES_DIR": private_dir(root),
                        "TLUXE_HLR_BRIDGE_TOKEN_SHA256": tok})
        client = TestClient(TestServer(make_app(cfg, store=MemoryStore(), workers=False)))
        await client.start_server()
        try:
            for path in ("/api/hlr/mt5/api/order", "/api/hlr/mt5/api/trade",
                         "/api/hlr/mt5/api/position", "/api/hlr/mt5/api/alert-email",
                         "/api/hlr/mt5/api/alert-test-email"):
                self.assertEqual((await client.get(path)).status, 403, path)
            r = await client.post("/api/hlr/mt5/api/status", headers={"Origin": ORIGIN})
            self.assertEqual(r.status, 405)
        finally:
            await client.close()
            tmp.cleanup()

    async def test_public_mode_is_off_by_default(self):
        """The strategy is not published by accident: it takes an explicit variable."""
        self.assertFalse(self.cfg.hlr_public)
        self.assertEqual((await self.client.get("/hlr-original/hlr-engine.js")).status, 401)

    async def test_public_wins_while_the_old_password_is_still_configured(self):
        """THE ROLLOUT STATE. Production has TLUXE_HLR_PASSWORD_HASH set today. Going public means
        adding TLUXE_HLR_PUBLIC first and removing the hash afterwards, so for a while BOTH exist.

        In that window the page must already be open and the sign-in must already be gone -
        otherwise the owner would be staring at a login card wondering whether the deploy worked,
        and would be tempted to delete the hash first, which takes the page away entirely.
        """
        tmp = tempfile.TemporaryDirectory()
        root = static_dir(tmp.name)
        cfg = from_env({"TLUXE_ENV": "development", "TLUXE_HLR_PUBLIC": "1",
                        "TLUXE_HLR_PASSWORD_HASH": HLR_HASH,      # still set - mid-rollout
                        "TLUXE_STATIC_DIR": str(root), "TLUXE_HLR_FILES_DIR": private_dir(root)})
        self.assertTrue(cfg.hlr_public)
        self.assertTrue(cfg.hlr_password_hash.reveal())           # both switches on at once
        client = TestClient(TestServer(make_app(cfg, store=MemoryStore(), workers=False)))
        await client.start_server()
        try:
            self.assertEqual((await client.get("/hlr-original/hlr-engine.js")).status, 200)
            self.assertEqual((await client.get(f"/{HLR_DOC_PATH}")).status, 200)
            self.assertEqual((await client.get("/api/hlr/auth/me")).status, 404)
        finally:
            await client.close()
            tmp.cleanup()

    async def test_removing_the_password_without_the_public_flag_closes_the_page(self):
        """The WRONG order, pinned so its consequence is documented rather than discovered.

        Delete the hash while TLUXE_HLR_PUBLIC is unset and the routes stop being registered: the
        page reports itself unavailable. It fails CLOSED, which is the right failure - but it is
        not what the owner would be expecting mid-rollout, so the order in the plan matters.
        """
        tmp = tempfile.TemporaryDirectory()
        root = static_dir(tmp.name)
        cfg = from_env({"TLUXE_ENV": "development",
                        "TLUXE_STATIC_DIR": str(root), "TLUXE_HLR_FILES_DIR": private_dir(root)})
        self.assertFalse(cfg.hlr_public)
        self.assertFalse(cfg.hlr_password_hash.reveal())
        client = TestClient(TestServer(make_app(cfg, store=MemoryStore(), workers=False)))
        await client.start_server()
        try:
            self.assertEqual((await client.get("/hlr-original/hlr-engine.js")).status, 404)
            self.assertEqual((await client.get("/api/hlr/files")).status, 404)
            self.assertEqual((await client.get("/")).status, 200)      # site itself unaffected
        finally:
            await client.close()
            tmp.cleanup()

    # ------------------------------------------------------- lifecycle

    async def test_logout_revokes_immediately(self):
        await self.login()
        self.assertEqual((await self.client.get("/api/hlr/auth/me")).status, 200)
        self.assertEqual((await self.client.post("/api/hlr/auth/logout",
                                                 headers={"Origin": ORIGIN})).status, 200)
        self.assertEqual((await self.client.get("/api/hlr/auth/me")).status, 401)
        self.assertEqual((await self.client.get("/hlr-original/hlr-engine.js")).status, 401)

    async def test_a_session_survives_a_restart_and_works_on_another_instance(self):
        """Railway restarts the container and may run more than one; sessions live in the shared
        store (PostgreSQL in production), not in the process. A second app object built over the
        same store stands in for both cases."""
        await self.login()
        cookie = self.client.session.cookie_jar.filter_cookies(self.client.make_url("/")).get(HLR_COOKIE)
        self.assertIsNotNone(cookie)

        # A brand-new app - fresh process state, fresh limiters - over the SAME store and password.
        restarted = from_env(env(TLUXE_STATIC_DIR=str(self.root), TLUXE_HLR_FILES_DIR=private_dir(self.root)))
        client2 = TestClient(TestServer(make_app(restarted, store=self.store, workers=False)))
        await client2.start_server()
        try:
            r = await client2.get("/api/hlr/auth/me", cookies={HLR_COOKIE: cookie.value})
            self.assertEqual(r.status, 200)                       # still signed in
            f = await client2.get("/hlr-original/hlr-engine.js", cookies={HLR_COOKIE: cookie.value})
            self.assertEqual(f.status, 200)
        finally:
            await client2.close()

    async def test_a_session_does_not_leak_into_a_separate_store(self):
        """Sanity check on the test above: it passes because the store is shared, not because the
        cookie is self-validating."""
        await self.login()
        cookie = self.client.session.cookie_jar.filter_cookies(self.client.make_url("/")).get(HLR_COOKIE)
        other = from_env(env(TLUXE_STATIC_DIR=str(self.root), TLUXE_HLR_FILES_DIR=private_dir(self.root)))
        client2 = TestClient(TestServer(make_app(other, store=MemoryStore(), workers=False)))
        await client2.start_server()
        try:
            r = await client2.get("/api/hlr/auth/me", cookies={HLR_COOKIE: cookie.value})
            self.assertEqual(r.status, 401)
        finally:
            await client2.close()

    async def test_rotating_the_password_invalidates_live_sessions(self):
        """The same store, the same cookie - but a new password means a new key space."""
        await self.login()
        self.assertEqual((await self.client.get("/api/hlr/auth/me")).status, 200)
        cookie = self.client.session.cookie_jar.filter_cookies(self.client.make_url("/")).get(HLR_COOKIE)
        self.assertIsNotNone(cookie)

        rotated = from_env(env(TLUXE_HLR_PASSWORD_HASH=OTHER_HASH, TLUXE_STATIC_DIR=str(self.root), TLUXE_HLR_FILES_DIR=private_dir(self.root)))
        client2 = TestClient(TestServer(make_app(rotated, store=self.store, workers=False)))
        await client2.start_server()
        try:
            r = await client2.get("/api/hlr/auth/me", cookies={HLR_COOKIE: cookie.value})
            self.assertEqual(r.status, 401)      # the old session no longer resolves
        finally:
            await client2.close()

    # ------------------------------------------------------- fail closed / CSRF

    async def test_without_a_password_configured_nothing_exists(self):
        tmp = tempfile.TemporaryDirectory()
        root = static_dir(tmp.name)
        cfg = from_env({"TLUXE_ENV": "development", "TLUXE_STATIC_DIR": str(root), "TLUXE_HLR_FILES_DIR": private_dir(root), "TLUXE_HLR_FILES_DIR": private_dir(root)})
        client = TestClient(TestServer(make_app(cfg, store=MemoryStore(), workers=False)))
        await client.start_server()
        try:
            for path in ("/hlr-original/hlr.html", "/hlr-original/hlr-engine.js",
                         "/api/hlr/auth/login", "/api/hlr/auth/me"):
                r = await client.get(path)
                self.assertEqual(r.status, 404, path)
                self.assertNotIn(b"HIGH / LOW REVERSAL", await r.read(), path)
            self.assertEqual((await client.get("/")).status, 200)   # the site itself is fine
        finally:
            await client.close()
            tmp.cleanup()

    async def test_a_plaintext_password_in_the_variable_is_refused(self):
        with self.assertRaises(ConfigError):
            from_env(env(TLUXE_HLR_PASSWORD_HASH="just-a-plain-password"))

    async def test_login_rejects_malformed_bodies(self):
        for body in ({"password": 123}, {"password": ""}, {}, {"password": "x" * 600}):
            self.assertEqual((await self.client.post("/api/hlr/auth/login", json=body,
                                                     headers={"Origin": ORIGIN})).status, 401)

    async def test_auth_is_never_treated_as_a_relay_upstream(self):
        await self.login()
        # /api/hlr/auth/* is registered first, so "auth" can never be read as an upstream name.
        self.assertIn((await self.client.get("/api/hlr/auth/me")).status, (200,))


if __name__ == "__main__":
    unittest.main()
