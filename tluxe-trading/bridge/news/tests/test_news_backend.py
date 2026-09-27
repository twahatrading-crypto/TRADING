"""News backend: Trading Economics normalization, dedup / revisions, bounded refresh, status truthfulness,
streaming entitlement detection, HTTP security. TEST DATA ONLY (tests/fixtures.py) - no network, no real key."""
import dataclasses
import json
import threading
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from fixtures import FAKE_TE_KEY, TOKEN, Clock, FakeHttp, cfg, te_event, te_news

from tluxe_news_bridge import server as S
from tluxe_news_bridge.config import ConfigError
from tluxe_news_bridge.feeds import NewsService
from tluxe_news_bridge.redact import Redactor
from tluxe_news_bridge.store import CALENDAR_MATERIAL, RecordStore
from tluxe_news_bridge.te_normalize import normalize_calendar, normalize_news, te_time_ms
from tluxe_news_bridge.te_rest import TeError, TeRestClient
from tluxe_news_bridge.te_stream import TeStream

HERE = Path(__file__).resolve().parents[1]
T0 = datetime(2026, 10, 14, 11, 0, tzinfo=timezone.utc).timestamp()  # 1.5 h before the TEST CPI release
RELEASE_MS = int(datetime(2026, 10, 14, 12, 30, tzinfo=timezone.utc).timestamp() * 1000)


class NoStream:
    state = "DISABLED"
    last_message_ms = None
    detail = None
    messages = records = 0

    def start(self):
        pass

    def stop(self):
        pass


def service(http: FakeHttp, clock: Clock, **over) -> NewsService:
    c = cfg(**over)
    return NewsService(c, rest=TeRestClient(c, http_get=http), stream=NoStream(), clock=clock)


class TestNormalize(unittest.TestCase):
    def test_calendar_fields_preserved(self):
        e = normalize_calendar(te_event(actual="3.3%"), 5)
        self.assertEqual((e["id"], e["provider"], e["providerEventId"], e["dedupKey"]), ("tradingeconomics:330001", "tradingeconomics", "330001", "tradingeconomics:330001"))
        self.assertEqual((e["actual"], e["forecast"], e["previous"], e["teForecast"], e["unit"]), ("3.3%", "3.1%", "3.2%", "3.1%", "%"))
        self.assertEqual((e["event"], e["category"], e["country"], e["currency"]), ("Core Inflation Rate YoY", "Core Inflation Rate", "United States", "USD"))
        self.assertEqual(e["scheduledAt"], RELEASE_MS)
        self.assertEqual(e["providerUpdatedAt"], int(datetime(2026, 10, 13, 9, tzinfo=timezone.utc).timestamp() * 1000))
        self.assertEqual(e["source"], "U.S. Bureau of Labor Statistics")
        self.assertEqual(e["sourceUrl"], "https://www.bls.gov")
        self.assertEqual(e["url"], "https://tradingeconomics.com/united-states/core-inflation-rate")
        self.assertEqual(e["releaseStatus"], "RELEASED")
        self.assertEqual(e["raw"]["Actual"], "3.3%")  # raw provider values kept
        self.assertEqual(e["receivedAt"], 5)

    def test_missing_actual_is_null_never_zero_or_forecast(self):
        for missing in ("", "   ", None):
            e = normalize_calendar(te_event(actual=missing), 1)
            self.assertIsNone(e["actual"])
            self.assertEqual(e["releaseStatus"], "SCHEDULED")
        e = normalize_calendar(te_event(actual="0", forecast=""), 1)
        self.assertEqual(e["actual"], "0")  # a genuine zero stays a zero
        self.assertIsNone(e["forecast"])
        rec = te_event()
        del rec["Actual"]
        self.assertIsNone(normalize_calendar(rec, 1)["actual"])

    def test_importance_mapping(self):
        for raw, label in ((1, "LOW"), (2, "MEDIUM"), (3, "HIGH"), ("3", "HIGH"), (0, None), (4, None), (None, None), ("x", None)):
            e = normalize_calendar(te_event(importance=raw), 1)
            self.assertEqual(e["importance"], label, raw)

    def test_utc_parsing_and_denver_display(self):
        ms = te_time_ms("2026-10-14T12:30:00")  # TE times are UTC
        self.assertEqual(ms, RELEASE_MS)
        self.assertEqual(te_time_ms("2026-10-14T12:30:00Z"), RELEASE_MS)
        self.assertEqual(te_time_ms("2026-10-14T08:30:00-04:00"), RELEASE_MS)
        den = datetime.fromtimestamp(ms / 1000, tz=ZoneInfo("America/Denver"))
        self.assertEqual(den.strftime("%Y-%m-%d %H:%M %Z"), "2026-10-14 06:30 MDT")
        winter = te_time_ms("2026-12-11T13:30:00")
        self.assertEqual(datetime.fromtimestamp(winter / 1000, tz=ZoneInfo("America/Denver")).strftime("%H:%M %Z"), "06:30 MST")
        for bad in ("", None, "0001-01-01T00:00:00", "tomorrow", "2026-13-40T99:00:00"):
            self.assertIsNone(te_time_ms(bad))

    def test_invalid_records_dropped_not_repaired(self):
        for bad in (None, [], {"Event": "x"}, te_event(cid=""), te_event(event=""), te_event(date="")):
            self.assertIsNone(normalize_calendar(bad, 1))

    def test_news_normalize_no_invented_sentiment(self):
        h = normalize_news(te_news(), 7)
        self.assertEqual((h["headline"], h["source"], h["importance"], h["providerSentiment"]), ("TEST DATA headline", "Trading Economics", "MEDIUM", None))
        self.assertEqual(h["sourceUrl"], "https://tradingeconomics.com/united-states/inflation-cpi")
        self.assertIsNone(normalize_news({"id": "1", "title": "", "date": "2026-10-14T13:00:00"}, 1))


class TestStore(unittest.TestCase):
    def test_duplicates_and_revisions(self):
        s = RecordStore(CALENDAR_MATERIAL, 100, "scheduledAt", lambda: 0)
        self.assertEqual(s.upsert(normalize_calendar(te_event(), 1)), "new")
        self.assertEqual(s.upsert(normalize_calendar(te_event(), 2)), "duplicate")
        self.assertEqual(s.upsert(normalize_calendar(te_event(actual="3.3%"), 3)), "revised")
        self.assertEqual(s.upsert(normalize_calendar(te_event(actual="3.3%", revised="3.3%"), 4)), "revised")
        self.assertEqual(len(s), 1)  # the SAME event, never a duplicate event
        r = s.all()[0]
        self.assertEqual((r["revision"], r["actual"], r["revised"], r["firstReceivedAt"]), (2, "3.3%", "3.3%", 1))
        self.assertEqual(r["revisions"][0]["changes"]["actual"], [None, "3.3%"])
        self.assertEqual(r["revisions"][1]["changes"]["revised"], [None, "3.3%"])
        self.assertEqual(s.counts, {"received": 4, "new": 1, "revised": 2, "duplicates": 1})
        items, seq = s.since(0, 10)
        self.assertEqual((len(items), seq), (1, 3))
        self.assertEqual(s.since(seq, 10)[0], [])

    def test_bounded(self):
        s = RecordStore(CALENDAR_MATERIAL, 10, "scheduledAt", lambda: 0)
        for k in range(50):
            s.upsert(normalize_calendar(te_event(cid=str(k), date=f"2026-10-{1 + k % 28:02d}T12:30:00"), k))
        self.assertEqual(len(s), 10)


class TestRest(unittest.TestCase):
    def test_request_shape_and_key_never_leaks(self):
        http = FakeHttp({"/calendar/country": (200, [te_event()])})
        c = TeRestClient(cfg(), http_get=http)
        self.assertEqual(len(c.calendar_window("2026-10-13", "2026-10-21")), 1)
        url = http.urls[0]
        self.assertIn("/calendar/country/united%20states,euro%20area", url)
        self.assertIn("/2026-10-13/2026-10-21?", url)
        self.assertIn("f=json", url)
        self.assertNotIn(FAKE_TE_KEY, Redactor(FAKE_TE_KEY)(url))
        self.assertNotIn("testsecretXYZ789", Redactor(FAKE_TE_KEY)(f"error at {url}"))

    def test_error_classification(self):
        for status, code in ((401, "AUTH"), (403, "ENTITLEMENT"), (409, "RATE_LIMITED"), (429, "RATE_LIMITED"), (500, "PROVIDER_ERROR")):
            with self.assertRaises(TeError) as e:
                TeRestClient(cfg(), http_get=FakeHttp({"/calendar": (status, "{}")})).calendar_updates()
            self.assertEqual(e.exception.code, code)
            self.assertNotIn(FAKE_TE_KEY, e.exception.message)
        with self.assertRaises(TeError) as e:
            TeRestClient(cfg(), http_get=FakeHttp(raise_exc=OSError(f"connect failed c={FAKE_TE_KEY}"))).calendar_updates()
        self.assertEqual(e.exception.code, "NETWORK")
        self.assertNotIn(FAKE_TE_KEY, e.exception.message)
        with self.assertRaises(TeError) as e:
            TeRestClient(cfg(), http_get=FakeHttp({"/calendar": (200, {"Message": "Unauthorized"})})).calendar_updates()
        self.assertEqual(e.exception.code, "AUTH")


class TestFeeds(unittest.TestCase):
    def test_no_key_not_configured_no_requests_no_events(self):
        http = FakeHttp()
        svc = service(http, Clock(T0), TRADING_ECONOMICS_API_KEY="")
        for _ in range(5):
            svc.tick()
        h = svc.health()["feeds"]
        self.assertEqual((h["calendar"]["status"], h["macro"]["status"], h["breaking"]["status"]), ("NOT_CONFIGURED", "NOT_CONFIGURED", "NOT_CONFIGURED"))
        self.assertEqual(http.urls, [])
        self.assertEqual(len(svc.calendar_store), 0)

    def test_rest_refresh_delayed_then_stale_then_recovers(self):
        clock = Clock(T0)
        http = FakeHttp({"/calendar/country": (200, [te_event(), te_event(cid="330002", event="Non Farm Payrolls", importance=3, forecast="150K", previous="142K")]),
                         "/calendar/updates": (200, [])})
        svc = service(http, clock)
        svc.tick()
        cal = svc.health()["feeds"]["calendar"]
        self.assertEqual((cal["status"], cal["latency"], cal["events"]), ("DELAYED", "DELAYED", 2))
        self.assertIsNotNone(cal["lastSuccessMs"])
        http.routes = {"/calendar": (500, "{}")}
        clock.t += 3 * 3600
        for _ in range(3):
            svc.tick()
        cal = svc.health()["feeds"]["calendar"]
        self.assertIn(cal["status"], ("STALE", "ERROR"))
        self.assertNotEqual(cal["status"], "DELAYED")
        http.routes = {"/calendar/country": (200, [te_event()]), "/calendar/updates": (200, [])}
        clock.t += 3600
        svc.tick()
        self.assertEqual(svc.health()["feeds"]["calendar"]["status"], "DELAYED")

    def test_auth_error_backs_off_no_tight_loop(self):
        clock = Clock(T0)
        http = FakeHttp({"/calendar": (401, "{}")})
        svc = service(http, clock)
        for _ in range(60):
            svc.tick()
            clock.t += 1
        self.assertEqual(len(http.urls), 1)
        cal = svc.health()["feeds"]["calendar"]
        self.assertEqual((cal["status"], cal["error"]["code"]), ("ERROR", "AUTH"))
        self.assertNotIn(FAKE_TE_KEY, json.dumps(cal))

    def test_refresh_is_bounded_and_fast_only_around_releases(self):
        clock = Clock(T0)
        http = FakeHttp({"/calendar/country": (200, [te_event()]), "/calendar/updates": (200, [])})
        svc = service(http, clock)
        for _ in range(3600):  # one hour, far from the 12:30 release until 12:15
            svc.tick()
            clock.t += 1
        quiet = len(http.urls)
        self.assertLessEqual(quiet, 4 + 12)  # 4 window refreshes + updates every 5 min at most
        http.urls.clear()
        clock.t = RELEASE_MS / 1000 - 10 * 60
        for _ in range(15 * 60):
            svc.tick()
            clock.t += 1
        updates = [u for u in http.urls if "/calendar/updates" in u]
        self.assertGreaterEqual(len(updates), 8)  # ~ every 60 s around the HIGH release
        self.assertLessEqual(len(http.urls), 20)

    def test_actual_arrives_as_revision_of_the_same_event(self):
        clock = Clock(T0)
        http = FakeHttp({"/calendar/country": (200, [te_event()]), "/calendar/updates": (200, [])})
        svc = service(http, clock)
        svc.tick()
        http.routes["/calendar/updates"] = (200, [te_event(actual="3.4%", last_update="2026-10-14T12:30:05")])
        clock.t = RELEASE_MS / 1000 + 30
        for _ in range(120):
            svc.tick()
            clock.t += 1
        events = svc.calendar_store.all()
        self.assertEqual(len(events), 1)
        self.assertEqual((events[0]["actual"], events[0]["releaseStatus"], events[0]["revision"]), ("3.4%", "RELEASED", 1))

    def test_macro_news_opt_in_and_breaking_not_configured(self):
        clock = Clock(T0)
        http = FakeHttp({"/calendar/country": (200, []), "/news": (200, [te_news()])})
        svc = service(http, clock, TE_NEWS_ENABLED="1")
        svc.tick()
        h = svc.health()["feeds"]
        self.assertEqual((h["macro"]["status"], h["macro"]["items"]), ("DELAYED", 1))
        self.assertEqual(h["breaking"]["status"], "NOT_CONFIGURED")
        self.assertEqual(len(svc.breaking_store), 0)
        off = service(FakeHttp({"/calendar/country": (200, [])}), clock)
        off.tick()
        self.assertEqual(off.health()["feeds"]["macro"]["status"], "DISABLED")
        with self.assertRaises(ConfigError):
            cfg(TLUXE_BREAKING_PROVIDER="some-scraper")

    def test_config_rules(self):
        with self.assertRaises(ConfigError):
            cfg(TLUXE_NEWS_TOKEN="short")
        with self.assertRaises(ConfigError):
            cfg(TLUXE_NEWS_ALLOWED_ORIGINS="*")
        with self.assertRaises(ConfigError):
            cfg(TLUXE_NEWS_HOST="0.0.0.0")
        c = cfg()
        self.assertEqual(c.port, 8768)
        self.assertIn("http://localhost:5182", c.allowed_origins)
        self.assertNotIn(FAKE_TE_KEY, repr(c))
        ex = (HERE / ".env.example").read_text()
        self.assertIn("TRADING_ECONOMICS_API_KEY=\n", ex)
        self.assertIn(".env", (HERE / ".gitignore").read_text().splitlines())


class TestStreaming(unittest.TestCase):
    """A local websocket server (TEST DATA) stands in for wss://stream.tradingeconomics.com."""

    def _server(self, handler):
        from websockets.sync.server import serve

        srv = serve(handler, "127.0.0.1", 0)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return srv, f"ws://127.0.0.1:{srv.socket.getsockname()[1]}/"

    def test_streaming_entitled_delivers_calendar_live(self):
        got = []

        def handler(ws):
            got.append(json.loads(ws.recv()))
            ws.send(json.dumps({"topic": "keepalive"}))
            ws.send(json.dumps(te_event(actual="3.4%")))
            time.sleep(1)

        srv, url = self._server(handler)
        c = dataclasses.replace(cfg(), stream_url=url)
        svc = NewsService(c, rest=TeRestClient(c, http_get=FakeHttp({"/calendar/country": (200, [te_event()]), "/calendar/updates": (200, [])})))
        svc.tick()
        svc.stream.start()
        deadline = time.time() + 5
        while time.time() < deadline and not svc.calendar_store.all()[0].get("actual"):
            time.sleep(0.05)
        self.assertEqual(got[0], {"topic": "subscribe", "to": "calendar"})
        self.assertEqual(svc.calendar_store.all()[0]["actual"], "3.4%")
        cal = svc.health()["feeds"]["calendar"]
        self.assertEqual((cal["status"], cal["latency"], cal["streaming"]["state"]), ("LIVE", "REALTIME", "CONNECTED"))
        svc.stream.stop()
        srv.shutdown()

    def test_streaming_not_entitled_detected_rest_continues_no_loop(self):
        attempts = []

        def handler(ws):
            attempts.append(1)
            ws.recv()
            ws.send(json.dumps({"topic": "error", "message": "Unauthorized: streaming is not included in your subscription"}))
            time.sleep(0.5)

        srv, url = self._server(handler)
        c = dataclasses.replace(cfg(), stream_url=url)
        sleeps = []
        box = {}
        # The stub records the requested pause and really waits (up to the test's end) like the production sleep does.
        stream = TeStream(c, lambda r: None, sleep=lambda s: (sleeps.append(s), box["s"].stop_evt.wait(min(s, 5))))
        box["s"] = stream
        svc = NewsService(c, rest=TeRestClient(c, http_get=FakeHttp({"/calendar/country": (200, [te_event()]), "/calendar/updates": (200, [])})), stream=stream)
        svc.tick()
        stream.start()
        deadline = time.time() + 5
        while time.time() < deadline and stream.state != "NOT_ENTITLED":
            time.sleep(0.05)
        time.sleep(0.3)
        self.assertEqual(stream.state, "NOT_ENTITLED")
        self.assertEqual(len(attempts), 1)  # detected once, then a 6 h hold-off - never a reconnect loop
        self.assertIn(6 * 3600, sleeps)
        cal = svc.health()["feeds"]["calendar"]
        self.assertEqual((cal["status"], cal["streaming"]["state"]), ("DELAYED", "NOT_ENTITLED"))
        stream.stop()
        srv.shutdown()

    def test_proxy_refusal_is_not_an_entitlement_verdict(self):
        class InvalidProxyStatus(Exception):
            pass

        def connect(url):
            raise InvalidProxyStatus("proxy rejected connection: HTTP 403")

        sleeps = []
        box = {}
        stream = TeStream(cfg(), lambda r: None, connect=connect, sleep=lambda s: (sleeps.append(s), box["s"].stop() if len(sleeps) >= 2 else None))
        box["s"] = stream
        stream.run()
        self.assertEqual(stream.state, "UNREACHABLE")
        self.assertNotIn(6 * 3600, sleeps)  # normal back-off, not the 6 h entitlement hold-off
        self.assertEqual(sleeps[:2], [5.0, 10.0])

    def test_stream_url_key_is_redacted(self):
        s = TeStream(cfg(), lambda r: None)
        self.assertNotIn("testsecretXYZ789", s.redact(s._url()))


class TestHttp(unittest.TestCase):
    def setUp(self) -> None:
        c = dataclasses.replace(cfg(), port=0)
        self.svc = NewsService(c, rest=TeRestClient(c, http_get=FakeHttp({"/calendar/country": (200, [te_event(), te_event(cid="2", importance=1)]), "/calendar/updates": (200, [])})), stream=NoStream())
        self.svc.tick()
        self.httpd = S.serve(c, self.svc, 1)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def req(self, path, token=TOKEN, origin="http://localhost:5182", method="GET"):
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method)
        if token:
            r.add_header("Authorization", f"Bearer {token}")
        if origin:
            r.add_header("Origin", origin)
        try:
            with urllib.request.urlopen(r, timeout=5) as res:
                t = res.read().decode()
                return res.status, dict(res.headers), json.loads(t) if t else None, t
        except urllib.error.HTTPError as e:
            t = e.read().decode()
            return e.code, dict(e.headers), json.loads(t) if t else None, t

    def test_health_and_calendar(self):
        st, h, body, txt = self.req("/v1/health")
        self.assertEqual(st, 200)
        self.assertEqual(h.get("Access-Control-Allow-Origin"), "http://localhost:5182")
        self.assertEqual(body["feeds"]["calendar"]["status"], "DELAYED")
        self.assertNotIn(FAKE_TE_KEY, txt)
        self.assertNotIn("testsecretXYZ789", txt)
        self.assertNotIn(TOKEN, txt)
        st, _, body, _ = self.req("/v1/calendar?since=0")
        self.assertEqual((st, len(body["events"]), body["seq"]), (200, 2, 2))
        self.assertEqual(self.req(f"/v1/calendar?since={body['seq']}")[2]["events"], [])
        self.assertEqual(self.req("/v1/headlines?feed=breaking")[2]["headlines"], [])

    def test_security(self):
        self.assertEqual(self.req("/v1/health", token=None)[0], 401)
        self.assertEqual(self.req("/v1/health", token=FAKE_TE_KEY)[0], 401)
        for origin in ("https://evil.example", "http://localhost:5180"):
            st, h, _, _ = self.req("/v1/health", origin=origin)
            self.assertEqual(st, 403)
            self.assertNotIn("Access-Control-Allow-Origin", h)
        self.assertEqual(self.req("/v1/health", origin="http://127.0.0.1:5182")[0], 200)
        self.assertEqual(self.req("/v1/calendar", method="POST")[0], 405)
        self.assertEqual(self.req("/v1/calendar?since=x")[0], 400)
        self.assertEqual(self.req("/v1/headlines?feed=twitter")[0], 400)

    def test_backend_never_scrapes_or_writes(self):
        import re

        src = "".join(p.read_text() for p in (HERE / "tluxe_news_bridge").glob("*.py"))
        for bad in ("google.com", "tradingview.com", "twitter.com", "x.com/", "reddit", "BeautifulSoup", "subprocess", ".write_text", "random."):
            self.assertFalse(bad in src, bad)
        self.assertIsNone(re.search(r"(?<![\w.])open\(", src))  # no file access (urlopen is the HTTPS client)


if __name__ == "__main__":
    unittest.main()
