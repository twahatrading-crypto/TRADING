"""HLR Original: every file is owner-only, served byte-for-byte, and reachable no other way.

The dashboard ships its own strategy to the browser (`hlr-engine.js` is readable source), so these
tests treat "can an anonymous request obtain ANY protected file, by any spelling of the URL" as the
property under test - not just whether the entry document is gated.

TEST DATA ONLY: a throwaway static directory with stand-in files. Nothing contacts MT5, IBKR or the
network, and no real HLR source is read.
"""
import tempfile
import unittest
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

from tluxe_gateway.app import make_app
from tluxe_gateway.auth import COOKIE, hash_password
from tluxe_gateway.config import from_env
from tluxe_gateway.hlr_page import HLR_DOC_PATH, SHIM_NAME, is_protected
from tluxe_gateway.store import MemoryStore

PASSWORD = "correct horse battery staple 42"
PW_HASH = hash_password(PASSWORD, n=2**12)

# Stand-ins for the copy. Bytes, not text: "byte-for-byte" is the actual guarantee, so the fixture
# must not be newline-translated on Windows.
DOC = b"<!doctype html><title>HLR</title><script src=\"hlr-engine.js\"></script>\n"
ENGINE = b"/* HIGH / LOW REVERSAL - engine. */ var HLR = {};\n"
PUBLIC_ASSET = b"console.log('public bundle');\n"

# Every spelling of a protected file an anonymous caller might try.
BYPASS_PATHS = [
    "/hlr-original/hlr-engine.js",
    "/hlr-original/hlr.html",
    "/hlr-original/./hlr-engine.js",
    "/assets/../hlr-original/hlr-engine.js",
    "/a/b/../../hlr-original/hlr-engine.js",
    "/%2e%2e/hlr-original/hlr-engine.js",
    "/hlr-original%2Fhlr-engine.js",
    "/./hlr-original/hlr-engine.js",
    # "//hlr-original/..." is omitted: the aiohttp test client reads a leading "//" as an absolute
    # URL and refuses to build the request, so it cannot be exercised here. A browser normalises it
    # to the single-slash path, which IS covered above.
]


def dev_env(**over):
    # Development: the in-memory store is allowed, so these tests need no database.
    # The HLR page has its OWN credential; the owner password stays unset so the rest of the
    # site remains publicly accessible, which is the whole point of the isolated gate.
    return {"TLUXE_ENV": "development", "TLUXE_HLR_PASSWORD_HASH": PW_HASH, **over}


class TestHlrGate(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name) / "web"
        root.mkdir()
        (root / "index.html").write_bytes(b"<!doctype html><title>TLUXE</title>")
        (root / "assets").mkdir()
        (root / "assets" / "index-abc.js").write_bytes(PUBLIC_ASSET)
        hlr = root.parent / "private" / "hlr-original"
        hlr.mkdir(parents=True, exist_ok=True)
        (hlr / "hlr.html").write_bytes(DOC)
        # The dashboard's other pages, reached by its own tabs and icon rail.
        for page in ("index.html", "vpr.html", "sweep.html"):
            (hlr / page).write_bytes(DOC)
        (hlr / "hlr-engine.js").write_bytes(ENGINE)
        (hlr / "deploy").mkdir()
        (hlr / "deploy" / "runner.js").write_bytes(b"// nested\n")
        self.root = root
        self.hlr_dir = hlr
        self.cfg = from_env(dev_env(TLUXE_STATIC_DIR=str(root), TLUXE_HLR_FILES_DIR=str(root.parent / "private" / "hlr-original")))
        self.client = TestClient(TestServer(make_app(self.cfg, store=MemoryStore(), workers=False)))
        await self.client.start_server()

    async def asyncTearDown(self) -> None:
        await self.client.close()
        self.tmp.cleanup()

    async def login(self) -> None:
        r = await self.client.post("/api/hlr/auth/login", json={"password": PASSWORD},
                                   headers={"Origin": "http://localhost:5182"})
        self.assertEqual(r.status, 200, await r.text())

    # ---------------------------------------------------------------- the gate

    async def test_anonymous_cannot_retrieve_any_protected_file_by_any_path(self):
        for path in BYPASS_PATHS:
            r = await self.client.get(path, allow_redirects=False)
            body = await r.read()
            self.assertIn(r.status, (401, 404, 403, 308), f"{path} -> {r.status}")
            self.assertNotIn(b"HIGH / LOW REVERSAL", body, f"strategy leaked via {path}")
            self.assertNotIn(b"var HLR", body, f"strategy leaked via {path}")
            self.assertNotEqual(body, DOC, f"document leaked via {path}")

    async def test_anonymous_gets_401_not_the_spa_fallback(self):
        """A miss must not quietly fall through to index.html - that would look like success."""
        r = await self.client.get(f"/{HLR_DOC_PATH}")
        self.assertEqual(r.status, 401)
        # The 401 body legitimately says "Sign in to TLUXE", so check for the SPA document itself.
        body = await r.read()
        self.assertNotIn(b"<!doctype html", body.lower())
        self.assertNotIn(b"<title>", body.lower())

    async def test_nested_protected_files_are_gated_too(self):
        r = await self.client.get("/hlr-original/deploy/runner.js")
        self.assertEqual(r.status, 401)

    async def test_owner_gets_non_html_files_byte_for_byte(self):
        """Strategy source is served exactly as uploaded - never rewritten, never filtered."""
        await self.login()
        r = await self.client.get("/hlr-original/hlr-engine.js")
        self.assertEqual(r.status, 200)
        self.assertEqual(await r.read(), ENGINE)

    async def test_html_differs_from_disk_by_exactly_the_shim_tag(self):
        """The ONE documented difference between disk and wire, pinned so it cannot grow.

        Every HTML document gets a single <script> tag added, which routes the dashboard's
        hard-coded loopback URLs to this origin and opens the page on XAUUSD. Nothing else is
        added, removed or reordered - and the file on disk is not touched at all.
        """
        await self.login()
        r = await self.client.get(f"/{HLR_DOC_PATH}")
        self.assertEqual(r.status, 200)
        served = await r.read()
        tag = b'<script src="' + SHIM_NAME.encode() + b'"></script>' + b"\n"
        self.assertIn(tag, served)
        self.assertEqual(served.replace(tag, b"", 1), DOC)   # remove it -> the original, exactly
        self.assertEqual(served.count(b"<script"), DOC.count(b"<script") + 1)
        self.assertEqual((self.hlr_dir / "hlr.html").read_bytes(), DOC)  # disk untouched

    async def test_shim_is_served_without_a_relay_so_xauusd_default_applies(self):
        """The XAUUSD default travels in the shim, so the shim cannot depend on the data relay.

        No bridge token is configured in this fixture. The shim must still be fetchable, and must
        still carry the switch to XAUUSD - otherwise the page opens on GC (hlr-gc.js ships
        DEFAULT_MARKET = 'GC'), which is not what this deployment is for.
        """
        await self.login()
        r = await self.client.get(f"/hlr-original/{SHIM_NAME}")
        self.assertEqual(r.status, 200)
        body = await r.read()
        self.assertIn(b"XAUUSD", body)
        self.assertIn(b"HLRGC", body)          # uses the dashboard's own public control
        self.assertIn(b"switchTo", body)

    async def test_session_cookie_is_what_authorises_not_the_url(self):
        await self.login()
        self.assertEqual((await self.client.get("/hlr-original/hlr-engine.js")).status, 200)
        await self.client.post("/api/auth/logout", headers={"Origin": "http://localhost:5182"})
        self.client.session.cookie_jar.clear()
        self.assertEqual((await self.client.get("/hlr-original/hlr-engine.js")).status, 401)

    async def test_fails_closed_when_no_hlr_password_is_configured(self):
        """No HLR password -> the routes are not registered -> the dashboard does not exist."""
        cfg = from_env({"TLUXE_ENV": "development", "TLUXE_STATIC_DIR": str(self.root)})
        self.assertTrue(cfg.public_market_data)  # market data opens up...
        client = TestClient(TestServer(make_app(cfg, store=MemoryStore(), workers=False)))
        await client.start_server()
        try:
            r = await client.get("/hlr-original/hlr-engine.js")
            self.assertEqual(r.status, 404)  # ...but the strategy is not served at all
            self.assertNotIn(b"HIGH / LOW REVERSAL", await r.read())
        finally:
            await client.close()

    # ---------------------------------------------------------------- caching

    async def test_protected_files_are_never_cached_by_anyone(self):
        await self.login()
        r = await self.client.get("/hlr-original/hlr-engine.js")
        cache = r.headers["Cache-Control"]
        self.assertIn("no-store", cache)
        self.assertIn("private", cache)
        self.assertNotIn("public", cache)
        self.assertIn("Cookie", r.headers["Vary"])

    # ---------------------------------------------------------------- framing

    async def test_only_the_entry_document_may_be_framed(self):
        await self.login()
        r = await self.client.get(f"/{HLR_DOC_PATH}")
        self.assertEqual(r.headers["X-Frame-Options"], "SAMEORIGIN")
        self.assertIn("frame-ancestors 'self'", r.headers["Content-Security-Policy"])

    async def test_every_dashboard_document_may_be_framed_not_just_the_entry_one(self):
        """The dashboard is a multi-page app: its tabs are relative links to index.html (Chart
        Workspace), vpr.html (Volume Profile) and sweep.html (Sweep Engulfing). If any of them kept
        the site-wide DENY, the browser refuses that navigation and the frame goes blank and opaque.
        That regression is what this test exists to catch."""
        await self.login()
        for name in ("hlr.html", "index.html", "vpr.html", "sweep.html"):
            r = await self.client.get(f"/hlr-original/{name}")
            self.assertEqual(r.status, 200, name)
            self.assertEqual(r.headers["X-Frame-Options"], "SAMEORIGIN", name)
            self.assertIn("frame-ancestors 'self'", r.headers["Content-Security-Policy"], name)

    async def test_non_documents_still_refuse_framing(self):
        await self.login()
        r = await self.client.get("/hlr-original/hlr-engine.js")
        self.assertEqual(r.headers["X-Frame-Options"], "DENY")

    async def test_every_other_route_keeps_framing_denied(self):
        await self.login()
        for path in ("/", "/index.html", "/api/config", "/assets/index-abc.js"):
            r = await self.client.get(path)
            self.assertEqual(r.headers["X-Frame-Options"], "DENY", path)
            self.assertIn("frame-ancestors 'none'", r.headers["Content-Security-Policy"], path)

    async def test_dashboard_cannot_reach_another_origin(self):
        await self.login()
        csp = (await self.client.get(f"/{HLR_DOC_PATH}")).headers["Content-Security-Policy"]
        for directive in ("default-src 'self'", "connect-src 'self'", "script-src 'self'"):
            self.assertIn(directive, csp)
        for forbidden in ("127.0.0.1", "localhost", "unsafe-eval"):
            self.assertNotIn(forbidden, csp)

    # ---------------------------------------------- the rest of the site is untouched

    async def test_public_routes_still_work_without_a_session(self):
        for path, needle in (("/", b"TLUXE"), ("/index.html", b"TLUXE"),
                             ("/assets/index-abc.js", b"public bundle"),
                             ("/healthz", b"ok"), ("/api/config", b"streamPath")):
            r = await self.client.get(path)
            self.assertEqual(r.status, 200, path)
            self.assertIn(needle, await r.read(), path)

    async def test_unknown_routes_still_fall_through_to_the_spa(self):
        r = await self.client.get("/engines/high-low-reversal")
        self.assertEqual(r.status, 200)
        self.assertIn(b"TLUXE", await r.read())

    async def test_no_hlr_data_route_exists_yet(self):
        """The relay is not built: there is no HLR API to expose, authenticated or otherwise."""
        await self.login()
        for path in ("/api/hlr/status", "/api/hlr/gc/api/snapshot", "/api/hlr/tracker/api/outcomes"):
            self.assertEqual((await self.client.get(path)).status, 404, path)

    async def test_missing_copy_is_reported_not_masked_by_the_spa(self):
        await self.login()
        (self.root.parent / "private" / "hlr-original" / "hlr.html").unlink()
        r = await self.client.get(f"/{HLR_DOC_PATH}")
        self.assertEqual(r.status, 404)
        self.assertNotIn(b"TLUXE", await r.read())


class TestIsProtected(unittest.TestCase):
    """The containment check the SPA handler relies on, exercised directly."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "hlr-original").mkdir()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_inside_is_protected(self):
        for rel in ("hlr-original", "hlr-original/hlr.html", "hlr-original/deploy/runner.js",
                    "assets/../hlr-original/hlr-engine.js"):
            self.assertTrue(is_protected(self.root, self.root / rel), rel)

    def test_outside_is_not(self):
        for rel in ("index.html", "assets/index-abc.js", "hlr-original-notes.txt"):
            self.assertFalse(is_protected(self.root, self.root / rel), rel)


if __name__ == "__main__":
    unittest.main()
