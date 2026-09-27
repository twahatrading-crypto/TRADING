"""Cloud / container mode: private-network binding only inside the container, unauthenticated liveness without
details, token still enforced. TEST DATA ONLY."""
import dataclasses
import json
import threading
import unittest
import urllib.error
import urllib.request

from fixtures import FAKE_KEY, TOKEN, cfg

from tluxe_ai_bridge import server as S
from tluxe_ai_bridge.config import ConfigError
from tluxe_ai_bridge.provider import OpenAIProvider


class TestCloudMode(unittest.TestCase):
    def test_all_interfaces_only_in_container(self):
        with self.assertRaises(ConfigError):
            cfg(TLUXE_AI_HOST="::")
        self.assertEqual(cfg(TLUXE_AI_HOST="::", TLUXE_CONTAINER="1").host, "::")

    def test_healthz_no_auth_no_details_but_api_still_needs_token(self):
        c = dataclasses.replace(cfg(), port=0)
        httpd = S.serve(c, OpenAIProvider(c), 1)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            with urllib.request.urlopen(f"{base}/healthz", timeout=5) as r:
                body = r.read().decode()
            self.assertEqual(json.loads(body), {"ok": True})
            self.assertNotIn(FAKE_KEY, body)
            with self.assertRaises(urllib.error.HTTPError) as e:
                urllib.request.urlopen(f"{base}/api/ai/health", timeout=5)
            self.assertEqual(e.exception.code, 401)
            self.assertNotIn(TOKEN, body)
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
