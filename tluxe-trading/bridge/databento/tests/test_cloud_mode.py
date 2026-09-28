"""Cloud / container mode for the Databento bridge (Standard plan, GLBX.MDP3). TEST DATA ONLY."""
import dataclasses
import json
import threading
import unittest
import urllib.error
import urllib.request

from fixtures import KEY, cfg

from tluxe_databento_bridge.config import ConfigError
from tluxe_databento_bridge.hub import Hub
from tluxe_databento_bridge.manager import Manager
from tluxe_databento_bridge.server import serve


class TestCloudMode(unittest.TestCase):
    def test_all_interfaces_only_in_container(self):
        with self.assertRaises(ConfigError):
            cfg(TLUXE_DB_BRIDGE_HOST="0.0.0.0")
        self.assertEqual(cfg(TLUXE_DB_BRIDGE_HOST="::", TLUXE_CONTAINER="1").host, "::")

    def test_dataset_and_standard_plan_from_environment(self):
        c = cfg(TLUXE_DB_DATASET="GLBX.MDP3", TLUXE_DB_PLAN="standard")
        self.assertEqual(c.plan, "standard")
        with self.assertRaises(ConfigError):
            cfg(TLUXE_DB_DATASET="XNAS.ITCH")
        mgr = Manager(c)
        self.assertEqual([r.session for r in mgr.runners], ["tape"])  # never an MBO / MBP-10 session on Standard
        self.assertEqual(mgr.hub.requested_schemas("tape"), ["trades", "ohlcv-1m"])
        self.assertEqual(mgr.hub.requested_schemas("book"), [])

    def test_healthz_no_auth_no_details(self):
        c = dataclasses.replace(cfg(), port=0)
        httpd = serve(c, Hub(c))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            with urllib.request.urlopen(f"{base}/healthz", timeout=5) as r:
                body = r.read().decode()
            self.assertEqual(json.loads(body), {"ok": True})
            self.assertNotIn(KEY, body)
            with self.assertRaises(urllib.error.HTTPError) as e:
                urllib.request.urlopen(f"{base}/v1/health", timeout=5)
            self.assertEqual(e.exception.code, 401)
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()


class TestRealDataStatus(unittest.TestCase):
    """/status and /v1/status report ONLY what was received. TEST DATA ONLY (hand-built dbn records)."""

    def setUp(self):
        from fixtures import GC_ID, T0, S, bar, mapping, trade
        self.c = dataclasses.replace(cfg(), port=0)
        self.hub = Hub(self.c)
        self.GC_ID, self.T0, self.S, self.bar, self.mapping, self.trade = GC_ID, T0, S, bar, mapping, trade

    def feed(self):
        h = self.hub
        h.on_session_connected("tape")
        for r in (self.mapping("GC.v.0", "GCZ6", self.GC_ID), self.trade(self.GC_ID, 2412.5, 3, self.S.BID, self.T0),
                  self.bar(self.GC_ID, self.T0 // 1_000_000_000 - 60, 2410, 2413, 2409, 2412, 57)):
            h.on_record("tape", r, h.now())

    def test_configuration_alone_is_not_verified(self):
        s = self.hub.status_summary("GC", with_prices=True)
        self.assertFalse(s["verifiedByRealData"])
        self.assertIsNone(s["activeContract"])
        self.assertIsNone(s["lastTrade"])
        self.assertEqual((s["dataset"], s["market"], s["subscribed"]), ("GLBX.MDP3", "COMEX", "GC.v.0"))
        self.assertEqual(s["schemas"], {"requested": ["trades", "ohlcv-1m"], "depth": "UNSUPPORTED"})

    def test_received_records_verify_and_prices_only_with_token(self):
        self.feed()
        s = self.hub.status_summary("GC", with_prices=True)
        self.assertTrue(s["verifiedByRealData"])
        self.assertEqual(s["activeContract"], "GCZ6")
        self.assertEqual((s["lastTrade"]["price"], s["lastTrade"]["size"]), (2412.5, 3))
        self.assertEqual((s["lastBar"]["close"], s["lastBar"]["volume"], s["lastBar"]["schema"]), (2412, 57, "ohlcv-1m"))
        self.assertTrue(s["lastEventUtc"].endswith("Z"))
        httpd = serve(self.c, self.hub)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            with urllib.request.urlopen(f"{base}/status?root=GC", timeout=5) as r:
                pub = json.loads(r.read())
            self.assertTrue(pub["verifiedByRealData"])
            self.assertNotIn("lastTrade", pub)  # public view: no prices
            self.assertNotIn("lastBar", pub)
            raw = json.dumps(pub)
            self.assertNotIn(KEY, raw)
            self.assertNotIn(self.c.token.reveal(), raw)
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(f"{base}/v1/status?root=GC", timeout=5)
            self.assertEqual(cm.exception.code, 401)
            req = urllib.request.Request(f"{base}/v1/status?root=GC", headers={"Authorization": f"Bearer {self.c.token.reveal()}"})
            with urllib.request.urlopen(req, timeout=5) as r:
                self.assertEqual(json.loads(r.read())["lastTrade"]["price"], 2412.5)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_container_uses_railway_port(self):
        self.assertEqual(cfg(TLUXE_CONTAINER="1", PORT="7311").port, 7311)
        self.assertEqual(cfg(PORT="7311").port, 8766)  # local: never the platform PORT
