"""Bridge tests. Uses an in-test FAKE MetaTrader5 module — test-only, never shipped as a mode."""
import io
import json
import logging
import threading
import unittest
import urllib.request
from datetime import datetime, timezone
from types import SimpleNamespace

from tluxe_mt5_bridge.config import ConfigError, from_env, mask_login
from tluxe_mt5_bridge.server import serve
from tluxe_mt5_bridge.terminal import BridgeError, Terminal
from tluxe_mt5_bridge.timeutil import TimeBasis, detect_offset, server_to_utc

TOKEN = "t" * 40
ATHENS = "Europe/Athens"  # EET (UTC+2) / EEST (UTC+3)


def wall(y, mo, d, h=0, mi=0):
    """Server wall time encoded as epoch (MT5 convention)."""
    return int(datetime(y, mo, d, h, mi, tzinfo=timezone.utc).timestamp())


class FakeMT5:
    TIMEFRAME_M1, TIMEFRAME_M5, TIMEFRAME_M15, TIMEFRAME_M30 = 1, 5, 15, 30
    TIMEFRAME_H1, TIMEFRAME_H4, TIMEFRAME_D1 = 16385, 16388, 16408

    def __init__(self, running=True, bars=None):
        self.running = running
        self.initialized = False
        self.init_calls = 0
        self.bars = bars or []
        self.symbols = {"XAUUSD.a": 2, "EURUSD.a": 5}

    def initialize(self, **kw):
        self.init_calls += 1
        self.initialized = self.running
        return self.running

    def last_error(self):
        return (-10003, "IPC initialize failed")

    def shutdown(self):
        self.initialized = False

    def terminal_info(self):
        if not (self.running and self.initialized):
            return None
        return SimpleNamespace(connected=True, trade_allowed=False, build=4410, company="Example Broker Ltd", name="MetaTrader 5")

    def account_info(self):
        return SimpleNamespace(login=51234567, server="ExampleBroker-Demo", company="Example Broker Ltd", trade_mode=0, currency="USD")

    def _sym(self, name):
        digits = self.symbols[name]
        return SimpleNamespace(name=name, description=name, path=f"Forex\\{name}", digits=digits, point=10 ** -digits,
                               trade_tick_size=10 ** -digits, trade_contract_size=100.0, currency_base="XAU",
                               currency_profit="USD", trade_mode=4, visible=True, spread_float=True)

    def symbols_get(self):
        return tuple(self._sym(n) for n in self.symbols)

    def symbol_info(self, name):
        return self._sym(name) if name in self.symbols else None

    def symbol_select(self, name, enable):
        return name in self.symbols

    def symbol_info_tick(self, name):
        if name not in self.symbols:
            return None
        return SimpleNamespace(time=wall(2026, 1, 14, 12, 0), time_msc=wall(2026, 1, 14, 12, 0) * 1000 + 250,
                               bid=2650.10, ask=2650.35, last=0.0)

    def copy_rates_from_pos(self, name, tf, start, count):
        if name not in self.symbols:
            return None
        newest_first = list(reversed(self.bars))
        page = newest_first[start:start + count]
        return list(reversed(page)) if page else None


def bar(st, o=100.0, h=101.0, l=99.0, c=100.5, tv=10, rv=0, sp=25):
    return {"time": st, "open": o, "high": h, "low": l, "close": c, "tick_volume": tv, "spread": sp, "real_volume": rv}


def cfg(**kw):
    env = {"TLUXE_BRIDGE_TOKEN": TOKEN, "TLUXE_MT5_SERVER_TIMEZONE": ATHENS}
    env.update(kw)
    return from_env(env)


class ConfigTests(unittest.TestCase):
    def test_token_required(self):
        with self.assertRaises(ConfigError):
            from_env({"TLUXE_BRIDGE_TOKEN": "short"})

    def test_refuses_all_interfaces(self):
        with self.assertRaises(ConfigError):
            from_env({"TLUXE_BRIDGE_TOKEN": TOKEN, "TLUXE_BRIDGE_HOST": "0.0.0.0"})

    def test_defaults_local_and_secrets_hidden(self):
        c = from_env({"TLUXE_BRIDGE_TOKEN": TOKEN, "TLUXE_MT5_PASSWORD": "hunter2"})
        self.assertEqual(c.host, "127.0.0.1")
        self.assertNotIn("hunter2", repr(c))
        self.assertNotIn(TOKEN, repr(c))
        self.assertEqual(mask_login(51234567), "****567")


class TimeTests(unittest.TestCase):
    def test_iana_handles_dst(self):
        b = TimeBasis("iana", ATHENS)
        # Winter: EET = UTC+2 → 12:00 server = 10:00 UTC
        self.assertEqual(server_to_utc(wall(2026, 1, 14, 12), b), wall(2026, 1, 14, 10))
        # Summer: EEST = UTC+3 → 12:00 server = 09:00 UTC
        self.assertEqual(server_to_utc(wall(2026, 7, 14, 12), b), wall(2026, 7, 14, 9))
        # D1 bar at server midnight = previous day 22:00/21:00 UTC
        self.assertEqual(server_to_utc(wall(2026, 1, 14), b), wall(2026, 1, 13, 22))

    def test_utc_server(self):
        self.assertEqual(server_to_utc(1_700_000_000, TimeBasis("iana", "UTC")), 1_700_000_000)

    def test_unresolved_never_pretends(self):
        self.assertIsNone(server_to_utc(1_700_000_000, TimeBasis("unresolved")))

    def test_detect_offset_only_from_fresh_ticks(self):
        now = 1_800_000_000
        self.assertEqual(detect_offset(now + 7200 - 3, now), 7200)
        self.assertIsNone(detect_offset(now + 7200 - 900, now))  # 15-minute-old tick: ambiguous


class TerminalTests(unittest.TestCase):
    def test_not_running_is_reported_not_faked(self):
        t = Terminal(cfg(), FakeMT5(running=False))
        h = t.health()
        self.assertEqual(h["terminal"]["state"], "NOT_RUNNING")
        self.assertEqual(h["error"]["code"], "MT5_NOT_RUNNING")
        with self.assertRaises(BridgeError) as e:
            t.rates("XAUUSD.a", "H1", 10)
        self.assertEqual(e.exception.code, "MT5_NOT_RUNNING")

    def test_terminal_restart_reinitialises(self):
        fake = FakeMT5()
        t = Terminal(cfg(), fake)
        t.ensure()
        self.assertEqual(t.state, "CONNECTED")
        fake.running = False
        t.ensure()
        self.assertEqual(t.state, "NOT_RUNNING")
        fake.running = True
        t._next_attempt = 0
        t.ensure()
        self.assertEqual(t.state, "CONNECTED")
        self.assertGreaterEqual(fake.init_calls, 2)

    def test_health_masks_login(self):
        h = Terminal(cfg(), FakeMT5()).health()
        self.assertEqual(h["account"]["loginMasked"], "****567")
        self.assertNotIn("51234567", json.dumps(h))
        self.assertEqual(h["account"]["tradeMode"], "demo")
        self.assertEqual(h["time"]["basis"], "iana")

    def test_rates_paging_utc_closed_volume_spread(self):
        start = wall(2026, 1, 5, 0)
        bars = [bar(start + i * 3600, tv=5 + i % 3, rv=0, sp=20 + i % 4) for i in range(7200)]
        t = Terminal(cfg(), FakeMT5(bars=bars))
        now = bars[-1]["time"] - 7200 + 1800  # UTC now inside the last (forming) bar
        out = t.rates("XAUUSD.a", "H1", 7000, now_utc=now)
        self.assertEqual(out["returned"], 7000)  # 5000 + 2000 across two pages
        rows = out["bars"]
        self.assertEqual([r["st"] for r in rows], [b["time"] for b in bars[-7000:]])  # oldest first, no dupes
        self.assertEqual(rows[0]["t"], rows[0]["st"] - 7200)  # EET winter
        self.assertTrue(all(r["closed"] for r in rows[:-1]))
        self.assertFalse(rows[-1]["closed"])
        self.assertTrue(all(r["rv"] is None for r in rows))  # 0 real volume = unavailable
        self.assertFalse(out["realVolumeAvailable"])
        self.assertEqual([r["sp"] for r in rows[:4]], [b["spread"] for b in bars[-7000:-6996]])
        self.assertEqual([r["tv"] for r in rows[:3]], [b["tick_volume"] for b in bars[-7000:-6997]])

    def test_history_limit_reported(self):
        t = Terminal(cfg(), FakeMT5(bars=[bar(wall(2026, 1, 5) + i * 60) for i in range(120)]))
        out = t.rates("EURUSD.a", "M1", 5000)
        self.assertEqual(out["returned"], 120)
        self.assertTrue(out["historyLimited"])

    def test_real_volume_kept_when_supplied(self):
        t = Terminal(cfg(), FakeMT5(bars=[bar(wall(2026, 1, 5), rv=17), bar(wall(2026, 1, 5, 1), rv=0)]))
        rows = t.rates("XAUUSD.a", "H1", 2)["bars"]
        self.assertEqual(rows[0]["rv"], 17)
        self.assertIsNone(rows[1]["rv"])

    def test_timezone_unresolved_refuses_to_label_utc(self):
        c = from_env({"TLUXE_BRIDGE_TOKEN": TOKEN})
        t = Terminal(c, FakeMT5(bars=[bar(wall(2026, 1, 5))]))
        t.ensure()
        t.basis = TimeBasis("unresolved")
        with self.assertRaises(BridgeError) as e:
            t.rates("XAUUSD.a", "H1", 1)
        self.assertEqual(e.exception.code, "TIMEZONE_UNRESOLVED")

    def test_missing_symbol(self):
        t = Terminal(cfg(), FakeMT5())
        with self.assertRaises(BridgeError) as e:
            t.quote("GOLD")
        self.assertEqual(e.exception.code, "SYMBOL_NOT_FOUND")

    def test_quote_spread_and_utc(self):
        q = Terminal(cfg(), FakeMT5()).quote("XAUUSD.a")
        self.assertEqual(q["spreadPoints"], 25)
        self.assertEqual(q["timeUtcMs"], wall(2026, 1, 14, 10) * 1000 + 250)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        c = cfg(TLUXE_BRIDGE_PORT="0")
        cls.fake = FakeMT5(bars=[bar(wall(2026, 1, 5) + i * 3600) for i in range(50)])
        cls.log = io.StringIO()
        logging.getLogger().addHandler(logging.StreamHandler(cls.log))
        logging.getLogger().setLevel(logging.INFO)
        cls.httpd = serve(c, Terminal(c, cls.fake))
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def req(self, path, token=TOKEN, origin=None, method="GET", extra=None):
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method)
        if token:
            r.add_header("Authorization", f"Bearer {token}")
        if origin:
            r.add_header("Origin", origin)
        for k, v in (extra or {}).items():
            r.add_header(k, v)
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, dict(resp.headers), (json.loads(resp.read() or b"null"))
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), json.loads(e.read() or b"null")

    def test_requires_token(self):
        self.assertEqual(self.req("/v1/health", token=None)[0], 401)
        self.assertEqual(self.req("/v1/health", token="x" * 40)[0], 401)

    def test_health_and_heartbeat(self):
        status, _, body = self.req("/v1/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["terminal"]["state"], "CONNECTED")
        self.assertIn("heartbeatAtMs", body["bridge"])

    def test_cors_only_for_allowed_origins(self):
        _, h, _ = self.req("/v1/health", origin="http://localhost:5181")
        self.assertEqual(h.get("Access-Control-Allow-Origin"), "http://localhost:5181")
        _, h, _ = self.req("/v1/health", origin="https://evil.example")
        self.assertIsNone(h.get("Access-Control-Allow-Origin"))
        # The old project's dev port is not authorised by default.
        _, h, _ = self.req("/v1/health", origin="http://localhost:5180")
        self.assertIsNone(h.get("Access-Control-Allow-Origin"))
        status, h, _ = self.req("/v1/health", token=None, origin="http://localhost:5181", method="OPTIONS",
                                extra={"Access-Control-Request-Private-Network": "true"})
        self.assertEqual(status, 204)
        self.assertEqual(h.get("Access-Control-Allow-Private-Network"), "true")

    def test_endpoints(self):
        self.assertEqual(self.req("/v1/symbols")[2]["count"], 2)
        self.assertEqual(self.req("/v1/symbol/GOLD")[2]["error"]["code"], "SYMBOL_NOT_FOUND")
        body = self.req("/v1/rates/XAUUSD.a?timeframe=H1&count=20")[2]
        self.assertEqual(body["returned"], 20)
        self.assertEqual(self.req("/v1/rates/XAUUSD.a?timeframe=W1&count=20")[2]["error"]["code"], "BAD_TIMEFRAME")

    def test_token_never_logged_or_returned(self):
        for p in ("/v1/health", "/v1/symbols", "/v1/rates/XAUUSD.a?count=3"):
            self.assertNotIn(TOKEN, json.dumps(self.req(p)[2]))
        self.assertNotIn(TOKEN, self.log.getvalue())


if __name__ == "__main__":
    unittest.main()
