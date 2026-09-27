"""CME Globex MDP 3.0 Standard plan (the default): trades + ohlcv-1m only, never mbo / mbp-10; entitlement errors are
per-schema NOT_ENTITLED (never a provider-wide AUTH_ERROR, never a reconnect loop); capability-based status.
TEST DATA ONLY (see fixtures.py)."""
import time
import unittest

import databento_dbn as dbn
import manager_helpers as mh
from fixtures import GC_ID, KEY, SI_ID, T0, FakeLive, S, bar, cfg, factory_from, heartbeat, mapping, mbo, snapshot, trade

from tluxe_databento_bridge import manager as M
from tluxe_databento_bridge.config import DEFAULT_ORIGINS, ConfigError
from tluxe_databento_bridge.entitlement import AUTH, ENTITLEMENT, OTHER, classify
from tluxe_databento_bridge.hub import STANDARD_DEPTH_REASON, Hub

A = mh.A
MS0 = T0 // 1_000_000
UNAUTHORIZED_MBO = "Not authorized for mbo schema"


def maps():
    return [mapping("GC.v.0", "GCZ6", GC_ID), mapping("SI.v.0", "SIZ6", SI_ID)]


def standard_hub(**over):
    clock = mh.Clock(MS0 + 10)
    h = Hub(cfg(**over), clock=clock)
    h.on_session_connected("tape")
    for r in maps():
        h.on_record("tape", r, clock.t)
    return h, clock


class Runner:
    """One session runner + manually drained ingest, like test_manager.Rig."""

    def __init__(self, session: str, scripts: list, **over) -> None:
        self.hub = Hub(cfg(**over), clock=mh.Clock(MS0 + 10))
        self.ingest = M.Ingest(self.hub)
        self.sleeps: list[float] = []
        self.runner = M.SessionRunner(session, self.hub.cfg, self.hub, self.ingest, factory_from(scripts), sleep=self._sleep, rand=lambda: 0.5)

    def _sleep(self, s: float) -> None:
        self.sleeps.append(s)
        time.sleep(0.01)

    def run_until(self, cond, timeout: float = 5.0) -> bool:
        if not self.runner.is_alive():
            self.runner.start()
        end = time.time() + timeout
        while time.time() < end:
            while self.ingest.drain_once(block=False):
                pass
            if cond():
                return True
            time.sleep(0.01)
        return False

    def stop(self) -> None:
        self.runner.stop()
        self.runner.join(3)
        while self.ingest.drain_once(block=False):
            pass


class TestClassification(unittest.TestCase):
    def test_unauthorized_schema_is_entitlement_not_auth(self):
        self.assertEqual(classify(UNAUTHORIZED_MBO), (ENTITLEMENT, "mbo"))
        self.assertEqual(classify("Not authorized for mbp-10 schema"), (ENTITLEMENT, "mbp-10"))
        self.assertEqual(classify("User is not entitled to dataset GLBX.MDP3"), (ENTITLEMENT, None))
        self.assertEqual(classify("License required for ohlcv-1m"), (ENTITLEMENT, "ohlcv-1m"))

    def test_genuine_auth_failures(self):
        self.assertEqual(classify("Authentication failed"), (AUTH, None))
        self.assertEqual(classify("invalid API key, was ****"), (AUTH, None))
        self.assertEqual(classify("CRAM challenge rejected"), (AUTH, None))

    def test_other(self):
        self.assertEqual(classify("connection reset by peer")[0], OTHER)


class TestStandardConfig(unittest.TestCase):
    def test_default_plan_is_standard(self):
        c = cfg()
        self.assertEqual(c.plan, "standard")
        self.assertFalse(c.depth_plan)
        self.assertEqual(cfg(TLUXE_DB_PLAN="MBO").plan, "mbo")
        with self.assertRaises(ConfigError):
            cfg(TLUXE_DB_PLAN="mbp-10")

    def test_5182_origins_added_existing_kept(self):
        for o in ("http://localhost:5182", "http://127.0.0.1:5182", "http://localhost:5181", "http://127.0.0.1:5181", "http://localhost:4181", "http://127.0.0.1:4181"):
            self.assertIn(o, DEFAULT_ORIGINS)
            self.assertIn(o, cfg().allowed_origins)

    def test_api_key_absent_fails_closed(self):
        with self.assertRaises(ConfigError):
            cfg(DATABENTO_API_KEY="")


class TestStandardSubscriptions(unittest.TestCase):
    def setUp(self) -> None:
        FakeLive.instances = []

    def test_manager_opens_only_the_tape_session(self):
        mgr = M.Manager(cfg(), factory=factory_from([]))
        self.assertEqual([r.session for r in mgr.runners], ["tape"])
        self.assertEqual(mgr.hub.requested_schemas("book"), [])
        self.assertEqual(mgr.hub.requested_schemas("tape"), ["trades", "ohlcv-1m"])
        mbo_mgr = M.Manager(cfg(TLUXE_DB_PLAN="mbo"), factory=factory_from([]))
        self.assertEqual([r.session for r in mbo_mgr.runners], ["book", "tape"])

    def test_standard_never_requests_mbo_or_mbp10(self):
        tape = FakeLive(maps() + [trade(GC_ID, 2400, 1, S.BID, T0)], hold=True)
        rig = Runner("tape", [tape])
        self.assertTrue(rig.run_until(lambda: rig.hub.roots["GC"].counts["trades"] == 1))
        schemas = [s["schema"] for inst in FakeLive.instances for s in inst.subs]
        self.assertEqual(sorted(set(schemas)), ["ohlcv-1m", "trades"])
        self.assertNotIn("mbo", schemas)
        self.assertNotIn("mbp-10", schemas)
        self.assertTrue(all("snapshot" not in s for s in tape.subs))
        self.assertEqual(tape.subs[0]["symbols"], ["GC.v.0", "SI.v.0"])
        rig.stop()

    def test_book_runner_never_connects_on_standard(self):
        rig = Runner("book", [FakeLive(hold=True)])
        rig.runner.start()
        rig.runner.join(3)
        self.assertFalse(rig.runner.is_alive())
        self.assertEqual(FakeLive.instances[0].subs, [])  # the scripted client was never even subscribed
        self.assertEqual(rig.hub.sessions["book"].state, "DISABLED")


class TestEntitlement(unittest.TestCase):
    def setUp(self) -> None:
        FakeLive.instances = []

    def test_unauthorized_mbo_on_mbo_plan_disables_depth_only_no_loop_no_auth_error(self):
        rejected = FakeLive(start_error=UNAUTHORIZED_MBO)
        rig = Runner("book", [rejected, FakeLive(hold=True)], TLUXE_DB_PLAN="mbo")
        rig.runner.start()
        rig.runner.join(5)
        self.assertFalse(rig.runner.is_alive(), "book runner must stop, not loop")
        self.assertEqual(len(FakeLive.instances), 2)  # one attempt only (2nd instance is the unused spare)
        self.assertNotIn(M.AUTH_RETRY_S, rig.sleeps)
        hub = rig.hub
        self.assertEqual(hub.requested_schemas("book"), [])
        # The trades path is untouched and reports LIVE on its own.
        hub.on_session_connected("tape")
        for r in maps() + [trade(GC_ID, 2400, 2, S.BID, T0)]:
            hub.on_record("tape", r, hub.now())
        st = hub.root_status(hub.roots["GC"])
        self.assertEqual(st["status"], "LIVE")
        self.assertNotEqual(st["status"], "AUTH_ERROR")
        self.assertEqual(st["capabilities"]["depth"], "NOT_ENTITLED")
        self.assertEqual(st["capabilities"]["mbo"], "NOT_ENTITLED")
        self.assertEqual(st["capabilities"]["trades"], "LIVE")
        self.assertEqual(hub.sessions["book"].last_error["code"], "NOT_ENTITLED")
        self.assertIsNone(hub.roots["GC"].book)

    def test_in_stream_error_msg_drops_only_that_schema(self):
        err = dbn.ErrorMsg(ts_event=T0, err="Not authorized for ohlcv-1m schema")
        first = FakeLive(maps() + [err], hold=True)
        second = FakeLive(maps() + [trade(GC_ID, 2400, 1, S.ASK, T0 + 5)], hold=True)
        rig = Runner("tape", [first, second])
        self.assertTrue(rig.run_until(lambda: len(FakeLive.instances) >= 2 and rig.hub.roots["GC"].counts["trades"] == 1))
        self.assertEqual([s["schema"] for s in second.subs], ["trades"])
        caps = rig.hub.root_status(rig.hub.roots["GC"])["capabilities"]
        self.assertEqual(caps["ohlcv"], "NOT_ENTITLED")
        self.assertEqual(caps["trades"], "LIVE")
        self.assertEqual(caps["volume"], "LIVE")  # trade sizes are still real volume
        rig.stop()

    def test_invalid_api_key_is_auth_error(self):
        rig = Runner("tape", [FakeLive(start_error=f"Authentication failed for {KEY}")])
        self.assertTrue(rig.run_until(lambda: M.AUTH_RETRY_S in rig.sleeps))
        h = rig.hub.health()
        self.assertEqual(h["instruments"]["GC"]["status"], "AUTH_ERROR")
        self.assertNotIn(KEY, str(h))
        rig.stop()

    def test_sdk_value_error_for_invalid_key_is_auth(self):
        def factory(key, hb):
            raise ValueError("invalid API key, was ****")

        hub = Hub(cfg(), clock=mh.Clock(MS0))
        r = M.SessionRunner("tape", hub.cfg, hub, M.Ingest(hub), factory, sleep=lambda s: None)
        self.assertEqual(r._connect_once(), "auth")
        self.assertEqual(hub.sessions["tape"].state, "AUTH_ERROR")


class TestStandardStatus(unittest.TestCase):
    def test_capabilities_standard(self):
        h, _ = standard_hub()
        st = h.root_status(h.roots["GC"])
        self.assertEqual(st["plan"], "standard")
        self.assertEqual(st["status"], "LIVE")  # no SYNCING BOOK on Standard
        caps = st["capabilities"]
        self.assertEqual((caps["trades"], caps["ohlcv"], caps["volume"]), ("WAITING", "WAITING", "WAITING"))
        self.assertEqual(caps["depth"], "UNSUPPORTED")
        self.assertEqual(caps["depthReason"], STANDARD_DEPTH_REASON)
        self.assertEqual((caps["mbo"], caps["mbp10"]), ("NOT_ENTITLED", "NOT_ENTITLED"))
        self.assertEqual(caps["level2Provider"], "NOT_CONNECTED")
        self.assertIn("IBKR / T4", caps["level2Required"])

    def test_trades_and_ohlcv_independent(self):
        h, clock = standard_hub()
        h.on_record("tape", trade(GC_ID, 2400.1, 3, S.BID, T0 + 1), clock.t)
        caps = h.root_status(h.roots["GC"])["capabilities"]
        self.assertEqual((caps["trades"], caps["ohlcv"], caps["volume"]), ("LIVE", "WAITING", "LIVE"))
        h.on_record("tape", bar(SI_ID, T0 // 10**9 // 60 * 60, 31, 31.2, 30.9, 31.1, 12), clock.t)
        si = h.root_status(h.roots["SI"])["capabilities"]
        self.assertEqual((si["trades"], si["ohlcv"], si["volume"]), ("WAITING", "LIVE", "LIVE"))

    def test_stale_then_offline(self):
        h, clock = standard_hub()
        h.on_record("tape", trade(GC_ID, 2400.1, 3, S.BID, T0 + 1), clock.t)
        clock.t += 60_000
        st = h.root_status(h.roots["GC"])
        self.assertEqual(st["status"], "STALE")
        self.assertEqual(st["capabilities"]["trades"], "STALE")
        h.on_record("tape", heartbeat(T0), clock.t)
        self.assertEqual(h.root_status(h.roots["GC"])["capabilities"]["trades"], "LIVE")
        h.on_session_closed("tape", reconnecting=True)
        st = h.root_status(h.roots["GC"])
        self.assertEqual(st["status"], "RECONNECTING")
        self.assertEqual(st["capabilities"]["trades"], "OFFLINE")

    def test_no_depth_ever_published_or_served(self):
        h, clock = standard_hub()
        h.on_record("tape", trade(GC_ID, 2400.1, 3, S.BID, T0 + 1), clock.t)
        # Even a stray MBO record (TEST DATA) is never turned into a book on Standard.
        for r in snapshot(GC_ID, [(S.BID, 2400.0, 5, 1)]) + [mbo(GC_ID, A.ADD, S.ASK, 2400.2, 1, 9, T0 + 3)]:
            h.on_record("book", r, clock.t)
        f = h.publish()["instruments"]["GC"]
        self.assertNotIn("snapshot", f)
        self.assertNotIn("levels", f)
        self.assertEqual(len(f["trades"]), 1)
        self.assertIsNone(h.book_snapshot("GC")["book"])
        self.assertIsNone(h.roots["GC"].book)

    def test_health_reports_plan_and_schemas_without_secrets(self):
        h, _ = standard_hub()
        hl = h.health()
        self.assertEqual(hl["plan"], "standard")
        self.assertEqual(hl["schemas"]["requested"], {"book": [], "tape": ["trades", "ohlcv-1m"]})
        self.assertEqual(hl["schemas"]["entitlements"]["mbo"]["state"], "NOT_ENTITLED")
        self.assertEqual(hl["schemas"]["entitlements"]["mbp-10"]["state"], "NOT_ENTITLED")
        self.assertEqual(hl["sessions"]["book"]["state"], "DISABLED")
        self.assertNotIn(KEY, str(hl))
        self.assertNotIn("t" * 40, str(hl))

    def test_gc_si_actual_contracts_from_mapping(self):
        h, clock = standard_hub()
        self.assertEqual(h.root_status(h.roots["GC"])["contract"], "GCZ6")
        self.assertEqual(h.root_status(h.roots["SI"])["contract"], "SIZ6")
        self.assertEqual(h.root_status(h.roots["GC"])["subscribed"], "GC.v.0")
        h.on_record("tape", mapping("GC.v.0", "GCG7", 42009, T0 + 10**12), clock.t)
        self.assertEqual(h.root_status(h.roots["GC"])["contract"], "GCG7")
        self.assertIsNone(h.take_resync("book"))  # no book resync on Standard
        self.assertIn("roll", h.take_resync("tape"))


if __name__ == "__main__":
    unittest.main()
