"""HTTP API + secret handling + determinism (TEST DATA)."""
import dataclasses
import io
import json
import logging
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from fixtures import GC_ID, KEY, SI_ID, T0, TOKEN, S, bar, cfg, mapping, mbo, snapshot, trade

from tluxe_databento_bridge.hub import Hub
from tluxe_databento_bridge.redact import Redactor, install_log_redaction
from tluxe_databento_bridge.server import serve

A = __import__("databento_dbn").Action
HERE = Path(__file__).resolve().parents[1]


def feed(h: Hub, records_book, records_tape) -> None:
    for s in ("book", "tape"):
        h.on_session_connected(s)
    for r in records_book:
        h.on_record("book", r)
    for r in records_tape:
        h.on_record("tape", r)


def script():
    m = [mapping("GC.v.0", "GCZ6", GC_ID), mapping("SI.v.0", "SIZ6", SI_ID)]
    book = m + snapshot(GC_ID, [(S.BID, 2400.0, 5, 1), (S.ASK, 2400.1, 3, 2)]) + snapshot(SI_ID, [(S.BID, 31.2, 2, 3)])
    for k in range(200):
        book.append(mbo(GC_ID, A.ADD if k % 3 else A.MODIFY, S.BID if k % 2 else S.ASK, 2399.5 + (k % 10) * 0.1, 1 + k % 4, 100 + k % 40, T0 + 10 + k))
    tape = m + [trade(GC_ID if k % 2 else SI_ID, 2400 + (k % 5) * 0.1 if k % 2 else 31.2, 1 + k % 3, [S.BID, S.ASK, S.NONE][k % 3], T0 + k * 10**8, seq=k) for k in range(300)]
    tape += [bar(GC_ID, T0 // 10**9 // 60 * 60 + 60 * k, 2400, 2401, 2399, 2400.5, 5 + k) for k in range(30)]
    return book, tape


class TestServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.hub = Hub(dataclasses.replace(cfg(TLUXE_DB_PLAN="mbo"), port=0))  # ephemeral test port
        b, t = script()
        feed(cls.hub, b, t)
        cls.hub.on_error("tape", f"transient failure mentioning {KEY}", fatal=False)
        cls.hub.publish()
        cls.httpd = serve(cls.hub.cfg, cls.hub)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def get(self, path: str, token: str | None = TOKEN, origin: str | None = "http://localhost:5181"):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        if origin:
            req.add_header("Origin", origin)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, dict(r.headers), r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read().decode()

    def test_requires_bridge_token(self):
        self.assertEqual(self.get("/v1/health", token=None)[0], 401)
        self.assertEqual(self.get("/v1/health", token="wrong" * 10)[0], 401)
        self.assertEqual(self.get(f"/v1/health", token=KEY)[0], 401)  # the Databento key is NOT a bridge credential

    def test_cors_allowlist(self):
        _, h, _ = self.get("/v1/health")
        self.assertEqual(h.get("Access-Control-Allow-Origin"), "http://localhost:5181")
        _, h2, _ = self.get("/v1/health", origin="http://localhost:5180")
        self.assertNotIn("Access-Control-Allow-Origin", h2)
        for origin in ("http://localhost:5182", "http://127.0.0.1:5182"):  # fresh preview port
            status, h3, _ = self.get("/v1/health", origin=origin)
            self.assertEqual(status, 200)
            self.assertEqual(h3.get("Access-Control-Allow-Origin"), origin)
        # 5182 origin still needs the bridge token.
        self.assertEqual(self.get("/v1/health", token=None, origin="http://localhost:5182")[0], 401)

    def test_endpoints_and_no_secret_anywhere(self):
        bodies = []
        for path in ("/v1/health", "/v1/feed?cursor=0", "/v1/book/GC", "/v1/book/SI", "/v1/trades/GC?after=0", "/v1/candles/GC?timeframe=M5", "/v1/nope", "/v1/candles/GC?timeframe=X"):
            status, _, body = self.get(path)
            bodies.append(body)
            self.assertNotIn(KEY, body)
            self.assertNotIn(TOKEN, body)
        health = json.loads(bodies[0])
        self.assertEqual(health["dataset"], "GLBX.MDP3")
        self.assertEqual(health["instruments"]["GC"]["contract"], "GCZ6")
        self.assertIn("mentioning ****", json.dumps(health["sessions"]))  # the error text was redacted
        book = json.loads(bodies[2])
        self.assertEqual(book["contract"], "GCZ6")
        self.assertIsNotNone(book["book"])
        trades = json.loads(bodies[4])
        self.assertTrue(all(t["contract"] == "GCZ6" for t in trades["trades"]))
        candles = json.loads(bodies[5])
        self.assertEqual(candles["source"], "databento")
        self.assertTrue(all(b["volume"] > 0 for b in candles["bars"]))

    def test_logs_never_contain_the_key(self):
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        root = logging.getLogger()
        root.addHandler(handler)
        try:
            install_log_redaction(Redactor(KEY, TOKEN))
            logging.getLogger("tluxe.databento").warning("connect failed for %s with token %s", KEY, TOKEN)
            try:
                raise RuntimeError(f"auth failed {KEY}")
            except RuntimeError:
                logging.getLogger("tluxe.databento").exception("boom")
            logging.getLogger("databento").warning("sdk said %s", KEY)
        finally:
            root.removeHandler(handler)
        out = stream.getvalue()
        self.assertIn("****", out)
        self.assertNotIn(KEY, out)
        self.assertNotIn(TOKEN, out)

    def test_no_test_data_switch_in_production_code(self):
        src = "".join(p.read_text() for p in (HERE / "tluxe_databento_bridge").glob("*.py")) + (HERE / "run_bridge.py").read_text()
        for bad in ("FakeLive", "fixtures", "TEST DATA", "synthetic", "random.gauss"):
            self.assertNotIn(bad, src)


class TestDeterminism(unittest.TestCase):
    def test_same_databento_input_same_book_trades_candles(self):
        outs = []
        for _ in range(2):
            h = Hub(cfg(TLUXE_DB_PLAN="mbo"), clock=lambda: T0 // 1_000_000)
            b, t = script()
            feed(h, b, t)
            outs.append(json.dumps([h.book_snapshot("GC"), h.book_snapshot("SI"), h.trades_after("GC", 0, 10_000), h.trades_after("SI", 0, 10_000),
                                    h.candles("GC", "M1", 100), h.candles("GC", "M15", 100), h.publish()["instruments"]], sort_keys=True))
        self.assertEqual(outs[0], outs[1])


if __name__ == "__main__":
    unittest.main()
