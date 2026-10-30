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

from tluxe_gateway.app import K_HLR, K_RELAY, make_app
from tluxe_gateway.auth import hash_password
from tluxe_gateway.config import from_env
from tluxe_gateway.hlr_relay import HlrRelay, allowed_path
from tluxe_gateway.mt5_relay import RelayError
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
    """Stands in for bridge/hlr-link on the trading PC.

    `inbox` collects what the GATEWAY sends unprompted, which is what the keepalive tests
    are about; `beat()` sends the client heartbeat that link.py sends every 10 s, which is
    what keeps the gateway's stale check satisfied.
    """

    def __init__(self) -> None:
        self.seen: list[tuple[str, str]] = []
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.task = None
        self.seq = 0
        self.answer = True

    async def run(self, client, token=TOKEN, bridge_id="test-pc", relay=None, answer=True):
        self.answer = answer
        ws = await client.ws_connect("/bridge/hlr", headers={"Authorization": f"Bearer {token}",
                                                             "X-TLUXE-Bridge-Id": bridge_id})
        self.ws = ws
        self.task = asyncio.create_task(self._loop(ws))
        await asyncio.sleep(0)       # let the gateway finish attaching before the test looks
        return ws

    def _env(self, body: dict) -> str:
        self.seq += 1
        return json.dumps({**body, "seq": self.seq, "ts": _now_ms()})

    async def beat(self):
        """What link.py's _heartbeats() sends: reachability only, never a body."""
        await self.ws.send_str(self._env({"type": "heartbeat",
                                          "health": {"mt5": {"reachable": True, "status": 200}}}))
        await asyncio.sleep(0.01)    # let the gateway apply it

    async def _loop(self, ws):
        async for msg in ws:
            if msg.type is not WSMsgType.TEXT:
                break
            m = json.loads(msg.data)
            if m.get("type") != "request":
                await self.inbox.put(m)   # a heartbeat, which link.py ignores and we record
                continue
            self.seen.append((m.get("upstream"), m.get("path")))
            if not self.answer:
                continue                  # a link that has gone quiet mid-request
            body = SNAPSHOT if m.get("upstream") == "gc" else {"ok": True, "echo": m.get("path")}
            await ws.send_str(self._env({"type": "response", "id": m["id"], "status": 200,
                                         "body": body}))

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

    # ------------------------------------------------------- keepalive / stale link
    #
    # THE FAULT THESE COVER. bridge/hlr-link waits on recv() with STALE_S = 45 s and
    # reconnects when the gateway has sent it nothing for that long. The gateway only ever
    # spoke on this link when a browser asked for something, so an idle dashboard forced a
    # reconnect - 27 of them in the 35 h measured on 2026-10-30 - and each one left the
    # gateway still holding the dead socket, reporting it as connected and answering 504s.

    async def test_the_gateway_now_speaks_first_on_an_idle_link(self):
        """The cure: a heartbeat arrives with no browser request involved."""
        await self.link.run(self.client)
        relay = self.client.app[K_HLR]
        await relay.heartbeat()                       # one tick of _hlr_heartbeat_worker

        msg = await asyncio.wait_for(self.link.inbox.get(), 2)
        self.assertEqual(msg["type"], "heartbeat")
        self.assertIsInstance(msg["seq"], int)
        self.assertIsInstance(msg["ts"], int)
        self.assertTrue(relay.status()["connected"])
        await self.link.stop()

    async def test_the_heartbeat_is_well_inside_the_clients_reconnect_timeout(self):
        """10 s against the client's 45 s: the margin is the whole point of the fix."""
        from tluxe_gateway.app import HLR_HB_S

        self.assertLessEqual(HLR_HB_S * 4, 45, "the heartbeat must leave room for lost ticks")

    async def test_a_healthy_link_is_never_closed_by_the_heartbeat(self):
        """Item 8. The client heartbeats every 10 s, so repeated ticks must be harmless."""
        await self.link.run(self.client)
        relay = self.client.app[K_HLR]
        for _ in range(5):
            await self.link.beat()                    # the client reports in, as it does
            await relay.heartbeat()
        self.assertTrue(relay.status()["connected"], "a live link must survive every tick")
        self.assertFalse(relay.status()["stale"])

        await self.login()                            # and it must still serve
        r = await self.client.get("/api/hlr/gc/api/snapshot")
        self.assertEqual(r.status, 200)
        self.assertEqual((await r.json())["last_trade_price"], 4013.5)
        await self.link.stop()

    async def test_a_slow_trading_pc_is_not_mistaken_for_a_dead_link(self):
        """Item 8 again, at the boundary that matters.

        The client sends its heartbeat only after probing mt5, gc and tracker in turn at up
        to 12 s each, so ~46 s between heartbeats is possible on a merely SLOW PC. The MT5
        relay's 30 s threshold would close that healthy link; the HLR relay's must not.
        """
        self.assertEqual(self.client.app[K_RELAY].STALE_S, 30,
                         "the MT5 relay's threshold must not change")
        self.assertGreaterEqual(HlrRelay.STALE_S, 2 * 46,
                                "must tolerate twice the client's worst-case heartbeat gap")

    async def test_a_silent_link_is_detected_closed_and_its_requests_failed(self):
        """Item 5: detection AND cleanup, not just a log line."""
        clock = [1_000_000.0]
        relay = self.client.app[K_HLR]
        relay.clock = lambda: clock[0]     # set BEFORE attach, so last_rx is on this clock
        await self.link.run(self.client)

        self.assertTrue(relay.status()["connected"])
        clock[0] += HlrRelay.STALE_S + 1              # the client has gone quiet
        self.assertTrue(relay.status()["stale"], "status must report the silence first")

        await relay.heartbeat()                       # the worker's next tick

        self.assertFalse(relay.status()["connected"], "a silent link must be detached")
        self.assertEqual(relay.status()["detail"], "stale")
        with self.assertRaises(RelayError) as caught:  # and must not serve from a dead socket
            await relay.request("mt5", "/api/status")
        self.assertEqual(caught.exception.code, "BRIDGE_OFFLINE")

    async def test_a_stale_close_fails_waiting_requests_instead_of_hanging_them(self):
        """A request in flight when the link is declared dead must fail at once."""
        clock = [2_000_000.0]
        relay = self.client.app[K_HLR]
        relay.clock = lambda: clock[0]
        await self.link.run(self.client, answer=False)

        task = asyncio.create_task(relay.request("mt5", "/api/status", timeout=30))
        await asyncio.sleep(0.05)                     # let it reach the (silent) link
        clock[0] += HlrRelay.STALE_S + 1
        await relay.heartbeat()

        with self.assertRaises(RelayError) as caught:
            await asyncio.wait_for(task, 2)
        self.assertEqual(caught.exception.code, "BRIDGE_OFFLINE")
        self.assertIn("HLR link", caught.exception.message, "and must say which link it was")

    async def test_make_before_break_replacement_still_works(self):
        """Item 6: a second link replaces the first, and the survivor keeps working."""
        await self.link.run(self.client)
        relay = self.client.app[K_HLR]
        self.assertEqual(relay.status()["bridgeId"], "test-pc")

        second = FakeLink()
        await second.run(self.client, bridge_id="test-pc-2")
        self.assertEqual(relay.status()["bridgeId"], "test-pc-2")
        self.assertTrue(relay.status()["connected"])

        await relay.heartbeat()                       # the survivor still gets heartbeats
        self.assertEqual((await asyncio.wait_for(second.inbox.get(), 2))["type"], "heartbeat")

        await self.login()                            # and the new link serves
        r = await self.client.get("/api/hlr/gc/api/snapshot")
        self.assertEqual(r.status, 200)
        await second.stop()

    async def test_concurrent_requests_each_get_their_own_answer(self):
        """Item 6: heartbeats share the socket with in-flight requests."""
        await self.link.run(self.client)
        await self.login()
        relay = self.client.app[K_HLR]

        results, _ = await asyncio.gather(
            asyncio.gather(self.client.get("/api/hlr/gc/api/snapshot"),
                           self.client.get("/api/hlr/mt5/api/status"),
                           self.client.get("/api/hlr/tracker/api/outcomes")),
            relay.heartbeat())
        self.assertEqual([r.status for r in results], [200, 200, 200])
        bodies = [await r.json() for r in results]
        self.assertEqual(bodies[0]["last_trade_price"], 4013.5)
        self.assertEqual(bodies[1]["echo"], "/api/status")
        self.assertEqual(bodies[2]["echo"], "/api/outcomes")
        await self.link.stop()

    async def test_the_bridge_socket_now_carries_a_websocket_ping(self):
        """Item 3: the transport-level half of the fix is actually enabled."""
        import inspect

        from tluxe_gateway import app as appmod

        src = inspect.getsource(appmod.make_app)
        hlr = src[src.index("async def hlr_bridge_ws"):]
        line = hlr[:hlr.index("await ws.prepare")]
        self.assertIn("heartbeat=30", line)
        self.assertNotIn("heartbeat=None", line)

    async def test_the_worker_is_actually_registered(self):
        """A heartbeat nothing calls is what caused the fault in the first place."""
        import inspect

        from tluxe_gateway import app as appmod

        src = inspect.getsource(appmod.make_app)
        self.assertIn("_hlr_heartbeat_worker", src, "the worker must be in the startup list")
        self.assertIn("K_HLR].heartbeat()", inspect.getsource(appmod._hlr_heartbeat_worker))

    # ------------------------------------------------------- log attribution

    async def test_hlr_events_are_not_reported_as_mt5_events(self):
        """The mislabelling that caused two wrong incident reports."""
        from tluxe_gateway.mt5_relay import Mt5Relay

        self.assertEqual(Mt5Relay.LABEL, "MT5 bridge link")
        self.assertEqual(HlrRelay.LABEL, "HLR link")
        self.assertNotEqual(HlrRelay.LOGGER.name, Mt5Relay.LOGGER.name)
        self.assertEqual(HlrRelay.LOGGER.name, "tluxe.gateway.hlr")

        with self.assertLogs("tluxe.gateway.hlr", level="WARNING") as caught:
            await self.link.run(self.client)
            second = FakeLink()
            await second.run(self.client, bridge_id="second-pc")
        self.assertTrue(any("HLR link" in m for m in caught.output), caught.output)
        self.assertFalse(any("MT5 bridge link" in m for m in caught.output), caught.output)
        await second.stop()

    # ------------------------------------------------------- routing separation

    async def test_xauusd_never_routes_through_the_legacy_mt5_relay(self):
        """Item 7. The two relays are different objects on different paths.

        The dashboard's XAUUSD requests must reach the HLR link even when the legacy
        /bridge/mt5 relay has no link at all - which is its state in production.
        """
        await self.link.run(self.client)
        await self.login()
        legacy = self.client.app[K_RELAY]
        self.assertIsNone(legacy.ws, "the legacy relay must be unconnected for this test")

        r = await self.client.get("/api/hlr/mt5/api/history?symbol=XAUUSD&timeframe=M1&count=5")
        self.assertEqual(r.status, 200, await r.text())
        self.assertEqual(("mt5", "/api/history?symbol=XAUUSD&timeframe=M1&count=5"),
                         self.link.seen[-1], "it must have gone over the HLR link")
        self.assertEqual(legacy.counts["requests"], 0, "and never over the legacy relay")

        await self.client.app[K_HLR].heartbeat()      # heartbeats stay on their own link too
        self.assertIsNone(legacy.ws)
        await self.link.stop()

    async def test_the_two_relays_are_separate_objects_with_separate_settings(self):
        hlr, legacy = self.client.app[K_HLR], self.client.app[K_RELAY]
        self.assertIsNot(hlr, legacy)
        self.assertNotEqual(hlr.STALE_S, legacy.STALE_S)
        self.assertEqual(legacy.STALE_S, 30, "the MT5 relay is untouched by this change")

    async def test_the_mt5_relay_keeps_its_own_label_threshold_and_behaviour(self):
        """Item 4: the shared transport changed, so pin what MT5 must still do.

        One deliberate side effect of the shared fix: the stale close now records
        detail="stale" for BOTH relays, where before the reason was overwritten with
        "closed". That is the reason being reported instead of lost; nothing else about the
        MT5 relay moves.
        """
        from tluxe_gateway.mt5_relay import Mt5Relay

        clock = [3_000_000.0]
        relay = Mt5Relay((), clock=lambda: clock[0])
        self.assertEqual(relay.LABEL, "MT5 bridge link")
        self.assertEqual(relay.LOGGER.name, "tluxe.gateway.mt5")
        self.assertEqual(relay.STALE_S, 30)

        class Ws:
            closed = None

            async def close(self, code=None, message=None):
                Ws.closed = code

            async def send_str(self, _):
                pass

        await relay.attach(Ws(), "mt5-vps")
        relay.last_rx = clock[0]
        await relay.heartbeat()                       # fresh: must only send
        self.assertTrue(relay.status()["connected"])
        self.assertIsNone(Ws.closed)

        clock[0] += 31                                # past ITS threshold, not the HLR one
        await relay.heartbeat()
        self.assertFalse(relay.status()["connected"])
        self.assertEqual(Ws.closed, 4001)
        self.assertEqual(relay.status()["detail"], "stale")


if __name__ == "__main__":
    unittest.main()
