"""Cloud / container mode for the news backend. TEST DATA ONLY."""
import dataclasses
import json
import threading
import unittest
import urllib.error
import urllib.request

from fixtures import FAKE_TE_KEY, FakeHttp, cfg

from tluxe_news_bridge import server as S
from tluxe_news_bridge.config import ConfigError
from tluxe_news_bridge.feeds import NewsService
from tluxe_news_bridge.te_rest import TeRestClient


class TestCloudMode(unittest.TestCase):
    def test_all_interfaces_only_in_container(self):
        with self.assertRaises(ConfigError):
            cfg(TLUXE_NEWS_HOST="0.0.0.0")
        self.assertEqual(cfg(TLUXE_NEWS_HOST="::", TLUXE_CONTAINER="1").host, "::")

    def test_healthz_and_no_credentials_means_not_configured(self):
        c = dataclasses.replace(cfg(TRADING_ECONOMICS_API_KEY=""), port=0)
        svc = NewsService(c, rest=TeRestClient(c, http_get=FakeHttp()))
        httpd = S.serve(c, svc, 1)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            with urllib.request.urlopen(f"{base}/healthz", timeout=5) as r:
                self.assertEqual(json.loads(r.read()), {"ok": True})
            with self.assertRaises(urllib.error.HTTPError) as e:
                urllib.request.urlopen(f"{base}/v1/health", timeout=5)
            self.assertEqual(e.exception.code, 401)
            h = svc.health()["feeds"]
            self.assertEqual({k: v["status"] for k, v in h.items()}, {"calendar": "NOT_CONFIGURED", "macro": "NOT_CONFIGURED", "breaking": "NOT_CONFIGURED"})
            self.assertNotIn(FAKE_TE_KEY, json.dumps(h))
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
