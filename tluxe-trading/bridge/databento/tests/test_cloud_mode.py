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
