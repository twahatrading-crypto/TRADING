"""Container entrypoint: gateway + embedded Databento bridge as two supervised processes. TEST DATA ONLY: the child here is a tiny stand-in
script; no Databento connection, no market data is generated. The real bridge's own behaviour is covered by
bridge/databento/tests."""
import asyncio
import logging
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import entrypoint as ep  # noqa: E402
from entrypoint import EmbeddedDatabento  # noqa: E402
from tluxe_gateway.health import databento_summary  # noqa: E402
from tluxe_gateway.logs import Redactor  # noqa: E402

KEY = "db-TESTKEYNOTREAL0123456789ABCDEF"
GATEWAY_SECRETS = {"TLUXE_OWNER_PASSWORD_HASH": "scrypt$16384$8$1$c2FsdA==$aGFzaA==", "DATABASE_URL": "postgresql://u:pw123456@db/x",
                   "TLUXE_AI_TOKEN": "ai-token-" + "a" * 40, "OPENAI_API_KEY": "sk-test-" + "o" * 40}


class TestEmbeddedConfig(unittest.TestCase):
    def test_only_with_a_key_and_no_external_service(self):
        self.assertIsNone(EmbeddedDatabento.from_env({}))
        self.assertIsNone(EmbeddedDatabento.from_env({"DATABENTO_API_KEY": KEY, "TLUXE_DATABENTO_URL": "http://tluxe-databento.railway.internal:8766"}))
        self.assertIsNone(EmbeddedDatabento.from_env({"DATABENTO_API_KEY": KEY, "TLUXE_DATABENTO_EMBEDDED": "0"}))
        self.assertIsNotNone(EmbeddedDatabento.from_env({"DATABENTO_API_KEY": KEY}))

    def test_key_leaves_the_gateway_env_and_reaches_only_the_child(self):
        env = {"DATABENTO_API_KEY": KEY, "TLUXE_DB_PLAN": "standard", **GATEWAY_SECRETS}
        e = EmbeddedDatabento.from_env(env)
        e.install(env)
        self.assertNotIn("DATABENTO_API_KEY", env)  # gone from the gateway process environment
        self.assertEqual(env["TLUXE_DATABENTO_URL"], "http://127.0.0.1:8766")
        self.assertGreaterEqual(len(env["TLUXE_DB_BRIDGE_TOKEN"]), 32)
        self.assertNotIn(KEY, repr(e))
        child = e.child_env()
        self.assertEqual(child["DATABENTO_API_KEY"], KEY)
        self.assertEqual((child["TLUXE_DB_DATASET"], child["TLUXE_DB_BRIDGE_HOST"], child["TLUXE_DB_PLAN"]), ("GLBX.MDP3", "127.0.0.1", "standard"))
        for k in GATEWAY_SECRETS:  # the bridge never sees the gateway's own secrets
            self.assertNotIn(k, child)
        self.assertNotIn("PORT", child)  # Railway's PORT belongs to the gateway; the bridge stays on loopback


def stand_in(tmp: Path, body: str) -> None:
    (tmp / "run_bridge.py").write_text(textwrap.dedent(body))


class TestSupervisor(unittest.IsolatedAsyncioTestCase):
    async def test_restarts_after_exit_and_redacts_the_key_in_child_logs(self):
        with tempfile.TemporaryDirectory() as d:
            stand_in(Path(d), """
                import os
                print("child sees key " + os.environ["DATABENTO_API_KEY"], flush=True)
                raise SystemExit(1)
            """)
            e = EmbeddedDatabento.from_env({"DATABENTO_API_KEY": KEY, "TLUXE_DB_BRIDGE_DIR": d})
            ep.BACKOFF_MIN_S = 0.05
            stop = asyncio.Event()
            with self.assertLogs("tluxe.entrypoint", level="INFO") as logs:
                task = asyncio.create_task(e.supervise(stop, Redactor(KEY)))
                for _ in range(100):
                    if e.state["starts"] >= 2:
                        break
                    await asyncio.sleep(0.05)
                stop.set()
                await asyncio.wait_for(task, 10)
            self.assertGreaterEqual(e.state["starts"], 2)
            self.assertEqual(e.state["lastExit"], 1)
            text = "\n".join(logs.output)
            self.assertIn("child sees key ****", text)
            self.assertNotIn(KEY, text)

    async def test_stop_terminates_a_running_child(self):
        with tempfile.TemporaryDirectory() as d:
            stand_in(Path(d), """
                import signal, sys, time
                signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
                print("running", flush=True)
                while True:
                    time.sleep(0.1)
            """)
            e = EmbeddedDatabento.from_env({"DATABENTO_API_KEY": KEY, "TLUXE_DB_BRIDGE_DIR": d})
            stop = asyncio.Event()
            task = asyncio.create_task(e.supervise(stop))
            for _ in range(100):
                if e.state["running"]:
                    break
                await asyncio.sleep(0.05)
            self.assertTrue(e.state["running"])
            stop.set()
            await asyncio.wait_for(task, 15)
            self.assertFalse(e.state["running"])
            self.assertEqual(e.state["lastExit"], 0)


class TestEntrypoint(unittest.IsolatedAsyncioTestCase):
    def test_gateway_process_never_gets_the_key(self):
        env = {"DATABENTO_API_KEY": KEY, **GATEWAY_SECRETS}
        e = EmbeddedDatabento.from_env(env)
        g = ep.gateway_env(env, e)
        self.assertNotIn("DATABENTO_API_KEY", g)
        self.assertNotIn(KEY, str(g))
        self.assertEqual((g["TLUXE_DATABENTO_URL"], g["TLUXE_DATABENTO_SOURCE"]), ("http://127.0.0.1:8766", "embedded"))
        self.assertEqual(g["TLUXE_AI_TOKEN"], GATEWAY_SECRETS["TLUXE_AI_TOKEN"])  # everything else passes through unchanged
        self.assertNotIn("DATABENTO_API_KEY", ep.gateway_env({"DATABENTO_API_KEY": KEY, "TLUXE_DATABENTO_URL": "http://x:1"}, None))

    async def test_gateway_exit_stops_the_bridge(self):
        with tempfile.TemporaryDirectory() as d:
            stand_in(Path(d), """
                import signal, sys, time
                signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
                while True:
                    time.sleep(0.1)
            """)
            probe = Path(d) / "gw.py"
            probe.write_text("import os, sys\nopen(sys.argv[1], 'w').write(str('DATABENTO_API_KEY' in os.environ))\n")
            out = Path(d) / "seen.txt"
            code = await asyncio.wait_for(ep.run({"DATABENTO_API_KEY": KEY, "TLUXE_DB_BRIDGE_DIR": d, "PATH": "/usr/bin:/bin"},
                                                 gateway_cmd=[sys.executable, str(probe), str(out)]), 20)
            self.assertEqual(code, 0)
            self.assertEqual(out.read_text(), "False")  # the gateway process never saw the key


def health(trades=0, ohlcv=0, last_ns=None, contract="GCZ6"):
    return {"provider": "Databento", "dataset": "GLBX.MDP3", "plan": "standard",
            "sessions": {"tape": {"state": "CONNECTED"}},
            "schemas": {"entitlements": {"mbo": {"state": "NOT_ENTITLED"}}},
            "instruments": {"GC": {"subscribed": "GC.v.0", "contract": contract, "instrumentId": 42, "status": "LIVE", "lastEventNs": last_ns,
                                   "counts": {"trades": trades, "ohlcv": ohlcv}, "tape": {"counts": {}, "lastIndex": trades}}}}


class TestSummary(unittest.TestCase):
    NOW = 1_790_000_000_000  # a Tuesday, market open

    def test_configuration_alone_is_never_verified(self):
        s = databento_summary(None, False, None, self.NOW, source=None)
        self.assertEqual((s["state"], s["verifiedByRealData"], s["activeContract"]), ("NOT CONNECTED", False, None))
        s = databento_summary(health(), True, None, self.NOW, source="embedded")
        self.assertFalse(s["verifiedByRealData"])  # connected, contract mapped, but no record received yet
        self.assertEqual(s["freshness"], "NO DATA YET")

    def test_verified_only_by_a_received_record(self):
        last_ns = (self.NOW - 2_000) * 1_000_000
        trade = {"price": 2412.3, "size": 2, "side": "B", "tsEventNs": last_ns}
        s = databento_summary(health(trades=5, ohlcv=1, last_ns=last_ns), True, None, self.NOW, source="embedded", last_trade=trade,
                              last_bar={"time": self.NOW // 1000 - 60, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 9, "isClosed": True})
        self.assertTrue(s["verifiedByRealData"])
        self.assertEqual((s["dataset"], s["market"], s["activeContract"], s["subscribed"]), ("GLBX.MDP3", "COMEX", "GCZ6", "GC.v.0"))
        self.assertEqual(s["lastTrade"]["price"], 2412.3)
        self.assertTrue(s["lastEventUtc"].endswith("Z"))
        self.assertEqual(s["depth"], "UNSUPPORTED")
        self.assertNotIn("token", str(s).lower())
