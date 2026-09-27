"""Intraday replay start recovery: "Invalid start time. Must be <T> or later" (seen live on the Standard plan).
The requested start stays inside Databento's rolling window; a rejection is clamped to the gateway's boundary and
retried ONCE; a second rejection falls back to live-only - never an endless reconnect loop.
TEST DATA ONLY (see fixtures.py)."""
import time
import unittest
from datetime import datetime, timezone

import databento_dbn as dbn
import manager_helpers as mh
from fixtures import GC_ID, SI_ID, T0, FakeLive, S, bar, cfg, factory_from, mapping, trade

from tluxe_databento_bridge import manager as M
from tluxe_databento_bridge.entitlement import START, classify, parse_start_boundary_ns
from tluxe_databento_bridge.hub import START_BOUNDARY_PAD_NS, Hub

MS0 = T0 // 1_000_000
NOW_MS = MS0 + 10
SEC_NS = 1_000_000_000
MIN_NS = 60 * 1_000_000_000
H_NS = 60 * MIN_NS


def iso(ns: int) -> str:
    return datetime.fromtimestamp(ns / 1e9, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def rejection(boundary_ns: int) -> str:
    return f"Invalid start time. Must be {iso(boundary_ns)} or later."


def recovered_session() -> FakeLive:
    """What an accepted Standard subscription delivers: symbol mappings, real-looking trades and ohlcv-1m bars."""
    minute = T0 // 10**9 // 60 * 60
    return FakeLive([
        mapping("GC.v.0", "GCZ6", GC_ID), mapping("SI.v.0", "SIH7", SI_ID),
        trade(GC_ID, 2400.1, 2, S.BID, T0 + 1), trade(SI_ID, 31.2, 1, S.ASK, T0 + 2),
        bar(GC_ID, minute, 2400, 2401, 2399, 2400.5, 11), bar(SI_ID, minute, 31, 31.3, 30.9, 31.2, 7),
    ], hold=True)


class Rig:
    def __init__(self, scripts: list, **over) -> None:
        self.hub = Hub(cfg(**over), clock=mh.Clock(NOW_MS))
        self.ingest = M.Ingest(self.hub)
        self.sleeps: list[float] = []
        self.runner = M.SessionRunner("tape", self.hub.cfg, self.hub, self.ingest, factory_from(scripts), sleep=self._sleep, rand=lambda: 0.5)

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


def recovered(hub: Hub) -> bool:
    gc, si = hub.roots["GC"], hub.roots["SI"]
    return gc.counts["trades"] == 1 and si.counts["trades"] == 1 and gc.counts["ohlcv"] == 1 and si.counts["ohlcv"] == 1


class TestParsing(unittest.TestCase):
    def test_boundary_parsed_from_gateway_error(self):
        ns = parse_start_boundary_ns("Invalid start time. Must be 2026-09-26T12:40:00Z or later.")
        self.assertEqual(ns, int(datetime(2026, 9, 26, 12, 40, tzinfo=timezone.utc).timestamp()) * 10**9)
        self.assertEqual(parse_start_boundary_ns("invalid start time, must be 2026-09-26T12:40:00.5+00:00 or later"), ns + 500_000_000)
        self.assertEqual(parse_start_boundary_ns("Invalid start time. Must be 2026-09-26 12:40:00 or later"), ns)  # naive -> UTC
        for bad in ("Invalid start time.", "Must be tomorrow or later", "Invalid start time. Must be 2026-99-99T99:99:99Z or later", ""):
            self.assertIsNone(parse_start_boundary_ns(bad))

    def test_start_error_is_not_auth_or_entitlement(self):
        self.assertEqual(classify("Invalid start time. Must be 2026-09-26T12:40:00Z or later.")[0], START)


class TestWindow(unittest.TestCase):
    def test_default_start_is_inside_the_window_and_minute_aligned(self):
        h = Hub(cfg(), clock=mh.Clock(NOW_MS))
        s = h.replay_window_start_ns()
        naive = (NOW_MS - 24 * 3_600_000) * 1_000_000
        self.assertGreaterEqual(s, naive + 30 * MIN_NS)  # never blindly now - 24 h
        self.assertLess(s, naive + 31 * MIN_NS)
        self.assertEqual(s % MIN_NS, 0)
        self.assertEqual(Hub(cfg(TLUXE_DB_REPLAY_MARGIN_MIN="90"), clock=mh.Clock(NOW_MS)).replay_window_start_ns() // MIN_NS, (naive + 90 * MIN_NS) // MIN_NS + 1)

    def test_request_older_than_the_boundary_is_clamped(self):
        h = Hub(cfg(), clock=mh.Clock(NOW_MS))
        boundary = h.replay_window_start_ns() + 2 * H_NS  # minute-aligned already
        h.on_error("tape", rejection(boundary), fatal=True)
        self.assertEqual(h.replay_window_start_ns(), boundary + START_BOUNDARY_PAD_NS)
        self.assertEqual(h.tape_replay_start_ns(), boundary + START_BOUNDARY_PAD_NS)
        # An older boundary never moves the floor back.
        h.on_error("tape", rejection(boundary - H_NS), fatal=True)
        self.assertEqual(h.replay_floor_ns, boundary + START_BOUNDARY_PAD_NS)
        # A floor is never turned into a start in the future.
        h.on_error("tape", rejection(NOW_MS * 1_000_000 + H_NS), fatal=True)
        self.assertEqual(h.replay_window_start_ns(), NOW_MS * 1_000_000)

    def test_start_error_is_not_auth_error(self):
        h = Hub(cfg(), clock=mh.Clock(NOW_MS))
        h.on_error("tape", rejection(T0), fatal=True)
        self.assertNotEqual(h.sessions["tape"].state, "AUTH_ERROR")
        self.assertEqual(h.sessions["tape"].last_error["code"], "START_TIME")
        self.assertNotEqual(h.root_status(h.roots["GC"])["status"], "AUTH_ERROR")


class TestRecovery(unittest.TestCase):
    def setUp(self) -> None:
        FakeLive.instances = []

    def _assert_recovered(self, rig: Rig) -> None:
        hub = rig.hub
        gc, si = hub.root_status(hub.roots["GC"]), hub.root_status(hub.roots["SI"])
        # Symbol mapping + ACTUAL contracts resolved from GC.v.0 / SI.v.0 after recovery.
        self.assertEqual((gc["subscribed"], gc["contract"], gc["instrumentId"]), ("GC.v.0", "GCZ6", GC_ID))
        self.assertEqual((si["subscribed"], si["contract"], si["instrumentId"]), ("SI.v.0", "SIH7", SI_ID))
        # Trades + OHLCV recovered (real exchange volume path).
        self.assertEqual((gc["capabilities"]["trades"], gc["capabilities"]["ohlcv"], gc["capabilities"]["volume"]), ("LIVE", "LIVE", "LIVE"))
        self.assertEqual(hub.candles("GC", "M1", 10)["bars"][0]["volume"], 11)
        self.assertEqual(gc["status"], "LIVE")
        self.assertEqual(hub.sessions["tape"].state, "CONNECTED")
        # Standard mode unchanged: only trades + ohlcv-1m on the continuous symbols; no mbo / mbp-10.
        for inst in FakeLive.instances:
            for sub in inst.subs:
                self.assertIn(sub["schema"], ("trades", "ohlcv-1m"))
                self.assertEqual(sub["symbols"], ["GC.v.0", "SI.v.0"])
                self.assertEqual(sub["stype_in"], "continuous")
        self.assertNotIn(M.AUTH_RETRY_S, rig.sleeps)
        self.assertNotIn(M.STORM_HOLD_S, rig.sleeps)

    def test_rejected_start_reconnects_once_with_a_valid_start_and_recovers(self):
        naive_ms = NOW_MS - 24 * 3_600_000
        boundary = (naive_ms + 60 * 60_000) * 1_000_000 // SEC_NS * SEC_NS  # gateway window begins ~1 h later than our request
        first = FakeLive(start_error=rejection(boundary))
        second = recovered_session()
        rig = Rig([first, second], TLUXE_DB_REPLAY_MARGIN_MIN="0")  # margin 0 forces the first request to be too old
        self.assertTrue(rig.run_until(lambda: recovered(rig.hub)))
        self.assertLess(first.subs[0]["start"], boundary)  # the first request WAS older than the boundary
        self.assertTrue(all(s["start"] >= boundary for s in second.subs))  # clamped to a valid start
        self.assertEqual(second.subs[0]["start"], boundary + START_BOUNDARY_PAD_NS)
        self.assertEqual(len([i for i in FakeLive.instances if i.subs]), 2)  # exactly one reconnect
        self._assert_recovered(rig)
        self.assertFalse(rig.hub.health()["replay"]["liveOnly"])
        rig.stop()

    def test_rejection_reported_when_the_session_closes(self):
        boundary = (NOW_MS - 20 * 3_600_000) * 1_000_000 // SEC_NS * SEC_NS
        first = FakeLive(close_error=rejection(boundary))
        second = recovered_session()
        rig = Rig([first, second])
        self.assertTrue(rig.run_until(lambda: recovered(rig.hub)))
        self.assertEqual(second.subs[0]["start"], boundary + START_BOUNDARY_PAD_NS)
        self._assert_recovered(rig)
        rig.stop()

    def test_in_stream_error_record_recovers(self):
        boundary = (NOW_MS - 20 * 3_600_000) * 1_000_000 // SEC_NS * SEC_NS
        first = FakeLive([dbn.ErrorMsg(ts_event=T0, err=rejection(boundary))], hold=True)
        second = recovered_session()
        rig = Rig([first, second])
        self.assertTrue(rig.run_until(lambda: recovered(rig.hub)))
        self.assertTrue(first.terminated.is_set())
        self.assertEqual(second.subs[0]["start"], boundary + START_BOUNDARY_PAD_NS)
        self._assert_recovered(rig)
        rig.stop()

    def test_unparseable_rejection_steps_inside_the_window(self):
        first = FakeLive(start_error="Invalid start time.")
        second = recovered_session()
        rig = Rig([first, second])
        self.assertTrue(rig.run_until(lambda: recovered(rig.hub)))
        self.assertGreaterEqual(second.subs[0]["start"] - first.subs[0]["start"], H_NS)
        self._assert_recovered(rig)
        rig.stop()

    def test_no_infinite_reconnect_loop_live_only_fallback(self):
        boundary = (NOW_MS - 20 * 3_600_000) * 1_000_000 // SEC_NS * SEC_NS
        scripts = [FakeLive(start_error=rejection(boundary + k * H_NS)) for k in range(2)] + [recovered_session()]
        scripts += [FakeLive(start_error=rejection(boundary)) for _ in range(20)]  # never used
        rig = Rig(scripts)
        self.assertTrue(rig.run_until(lambda: recovered(rig.hub)))
        time.sleep(0.3)
        attempts = [i for i in FakeLive.instances if i.subs]
        self.assertEqual(len(attempts), 3)  # rejected, corrected + rejected, live-only: then it STAYS connected
        self.assertTrue(all("start" in s for s in attempts[0].subs + attempts[1].subs))
        self.assertTrue(all("start" not in s for s in attempts[2].subs))  # live-only: no start at all
        h = rig.hub.health()
        self.assertTrue(h["replay"]["liveOnly"])
        self.assertIn("live-only", h["replay"]["liveOnlyReason"])
        gc = h["instruments"]["GC"]
        self.assertEqual(gc["contract"], "GCZ6")
        self.assertEqual(gc["capabilities"]["trades"], "LIVE")
        self.assertEqual(gc["status"], "DEGRADED")  # the missing history is flagged as a gap, never filled
        self.assertGreaterEqual(gc["counts"]["tapeGaps"], 1)
        self.assertEqual(rig.sleeps.count(1.0), 2)  # two short pauses, no backoff escalation / storm hold
        rig.stop()


if __name__ == "__main__":
    unittest.main()
