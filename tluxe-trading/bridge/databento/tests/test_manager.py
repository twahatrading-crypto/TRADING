"""Connection manager tests with a scripted Live stand-in (TEST DATA): subscriptions, auth failure, disconnect +
snapshot recovery, trade replay recovery, reconnect storm, resync on F_MAYBE_BAD_BOOK, backpressure."""
import threading
import time
import unittest

import manager_helpers as mh
from fixtures import GC_ID, KEY, SI_ID, T0, FakeLive, S, bar, cfg, factory_from, heartbeat, mapping, mbo, snapshot, trade

from tluxe_databento_bridge import manager as M
from tluxe_databento_bridge.book import VALID
from tluxe_databento_bridge.hub import Hub

A = mh.A
MS0 = T0 // 1_000_000


def maps():
    return [mapping("GC.v.0", "GCZ6", GC_ID), mapping("SI.v.0", "SIZ6", SI_ID)]


class Rig:
    """Hub + ingest (manually drained) + one runner driven by a scripted factory and a fake sleep."""

    def __init__(self, session: str, scripts: list, **over) -> None:
        self.clock = mh.Clock(MS0 + 10)
        self.hub = Hub(cfg(**{"TLUXE_DB_PLAN": "mbo", **over}), clock=self.clock)
        self.ingest = M.Ingest(self.hub)
        self.sleeps: list[float] = []
        self.runner = M.SessionRunner(session, self.hub.cfg, self.hub, self.ingest, factory_from(scripts), sleep=self._sleep, rand=lambda: 0.5)

    def _sleep(self, s: float) -> None:
        self.sleeps.append(s)
        time.sleep(0.01)

    def drain(self) -> None:
        while self.ingest.drain_once(block=False):
            pass

    def run_until(self, cond, timeout: float = 5.0) -> bool:
        if not self.runner.is_alive():
            self.runner.start()
        end = time.time() + timeout
        while time.time() < end:
            self.drain()
            if cond():
                return True
            time.sleep(0.01)
        return False

    def stop(self) -> None:
        self.runner.stop()
        self.runner.join(3)
        self.drain()


class TestManager(unittest.TestCase):
    def setUp(self) -> None:
        FakeLive.instances = []

    def test_initial_connection_subscribes_gc_and_si_with_snapshot(self):
        book = FakeLive(maps() + snapshot(GC_ID, [(S.BID, 2400.0, 5, 1)]) + snapshot(SI_ID, [(S.ASK, 31.2, 3, 2)]), hold=True)
        rig = Rig("book", [book])
        self.assertTrue(rig.run_until(lambda: rig.hub.roots["SI"].book is not None and rig.hub.roots["SI"].book.state == VALID))
        self.assertEqual(book.subs, [{"dataset": "GLBX.MDP3", "schema": "mbo", "symbols": ["GC.v.0", "SI.v.0"], "stype_in": "continuous", "snapshot": True}])
        self.assertEqual(rig.hub.roots["GC"].contract, "GCZ6")
        self.assertEqual(rig.hub.roots["SI"].contract, "SIZ6")
        self.assertEqual(rig.hub.sessions["book"].state, "CONNECTED")
        rig.stop()

    def test_tape_session_uses_intraday_replay(self):
        tape = FakeLive(maps() + [trade(GC_ID, 2400, 1, S.BID, T0), bar(GC_ID, T0 // 10**9 // 60 * 60, 1, 2, 1, 2, 5)], hold=True)
        rig = Rig("tape", [tape])
        self.assertTrue(rig.run_until(lambda: rig.hub.roots["GC"].tape is not None and rig.hub.roots["GC"].tape.counts["accepted"] == 1))
        schemas = [s["schema"] for s in tape.subs]
        self.assertEqual(schemas, ["trades", "ohlcv-1m"])
        # 24 h back, kept 30 min INSIDE Databento's rolling window, rounded up to a whole minute (never exactly now - 24 h).
        raw = (MS0 + 10 - 24 * 3_600_000 + 30 * 60_000) * 1_000_000
        window = -(-raw // 60_000_000_000) * 60_000_000_000
        self.assertTrue(all(s["start"] == window for s in tape.subs))
        self.assertGreater(window, (MS0 + 10 - 24 * 3_600_000) * 1_000_000)
        rig.stop()

    def test_auth_error_is_reported_redacted_and_not_retried_in_a_tight_loop(self):
        bad = FakeLive(start_error=f"Authentication failed (key {KEY})")
        rig = Rig("book", [bad])
        self.assertTrue(rig.run_until(lambda: M.AUTH_RETRY_S in rig.sleeps))
        st = rig.hub.health()
        self.assertEqual(st["instruments"]["GC"]["status"], "AUTH_ERROR")
        self.assertNotIn(KEY, str(st))
        rig.stop()

    def test_disconnect_then_snapshot_recovery(self):
        first = FakeLive(maps() + snapshot(GC_ID, [(S.BID, 2400.0, 5, 1)]) + [mbo(GC_ID, A.ADD, S.BID, 2399.9, 2, 7, T0 + 50)], close_error="connection lost")
        second = FakeLive(maps() + snapshot(GC_ID, [(S.ASK, 2401.0, 4, 9)], ts=T0 + 10**10), hold=True)
        rig = Rig("book", [first, second])
        ok = rig.run_until(lambda: len(FakeLive.instances) >= 2 and rig.hub.roots["GC"].book is not None and rig.hub.roots["GC"].book.state == VALID and 9 in rig.hub.roots["GC"].book.orders)
        self.assertTrue(ok)
        gc = rig.hub.roots["GC"].book
        self.assertEqual(gc.snapshot(), {"bids": [], "asks": [[2401.0, 4, 1]]})  # old book never carried over
        self.assertEqual(rig.hub.sessions["book"].reconnects, 1)
        self.assertEqual(second.subs[0]["snapshot"], True)
        rig.stop()

    def test_trade_replay_recovery_no_duplicate_volume(self):
        trades = [trade(GC_ID, 2400 + k * 0.1, 2, S.BID if k % 2 else S.ASK, T0 + k * 10**9, seq=k) for k in range(30)]
        si_last = trade(SI_ID, 31.0, 1, S.ASK, T0 + 29 * 10**9)
        first = FakeLive(maps() + trades + [si_last], close_error="connection reset")
        replay_start = trades[-1].ts_event - 60 * 10**9
        overlap = [t for t in trades if t.ts_event >= replay_start] + [si_last]
        second = FakeLive(maps() + overlap + [trade(GC_ID, 2410, 7, S.BID, T0 + 40 * 10**9, seq=99)], hold=True)
        rig = Rig("tape", [first, second])
        ok = rig.run_until(lambda: rig.hub.roots["GC"].tape is not None and rig.hub.roots["GC"].tape.counts["accepted"] == 31)
        self.assertTrue(ok)
        self.assertEqual(second.subs[0]["start"], replay_start)
        tape = rig.hub.roots["GC"].tape
        self.assertEqual(tape.volume["buy"] + tape.volume["sell"] + tape.volume["unknown"], 30 * 2 + 7)
        self.assertEqual(tape.counts["duplicates"], 30)
        self.assertEqual(rig.hub.roots["SI"].tape.counts["accepted"], 1)
        rig.stop()

    def test_reconnect_storm_holds_off(self):
        rig = Rig("book", [FakeLive(start_error="connection refused") for _ in range(20)])
        self.assertTrue(rig.run_until(lambda: M.STORM_HOLD_S in rig.sleeps, timeout=8))
        self.assertTrue(rig.hub.sessions["book"].reconnects >= M.STORM_MAX)
        self.assertLessEqual(max(s for s in rig.sleeps if s != M.STORM_HOLD_S), 60)
        rig.stop()

    def test_maybe_bad_book_triggers_snapshot_resync(self):
        first = FakeLive(maps() + snapshot(GC_ID, [(S.BID, 2400.0, 5, 1)]) + [mbo(GC_ID, A.ADD, S.BID, 2399.0, 1, 5, T0 + 99, flags=128 | 4)], hold=True)
        second = FakeLive(maps() + snapshot(GC_ID, [(S.BID, 2400.0, 6, 1)], ts=T0 + 10**10), hold=True)
        rig = Rig("book", [first, second])
        ok = rig.run_until(lambda: len(FakeLive.instances) >= 2 and rig.hub.roots["GC"].book is not None and rig.hub.roots["GC"].book.state == VALID and rig.hub.roots["GC"].book.orders.get(1) is not None and rig.hub.roots["GC"].book.orders[1].size == 6)
        self.assertTrue(ok)
        self.assertTrue(first.terminated.is_set())
        self.assertEqual(rig.hub.sessions["book"].resyncs, 1)
        self.assertEqual(rig.hub.sessions["book"].reconnects, 0)
        rig.stop()

    def test_backpressure_sheds_book_backlog_and_resyncs_never_silently(self):
        hub = Hub(cfg(TLUXE_DB_PLAN="mbo"), clock=mh.Clock(MS0))
        ing = M.Ingest(hub)
        for r in maps():
            ing.put("book", r)
            ing.put("tape", r)
        for r in snapshot(GC_ID, [(S.BID, 2400.0, 5, 1)]):
            ing.put("book", r)
        while ing.drain_once(block=False):
            pass
        old = M.HARD_QUEUE_LIMIT
        M.HARD_QUEUE_LIMIT = 100
        try:
            for k in range(M.BATCH + 500):
                ing.put("book", mbo(GC_ID, A.ADD, S.BID, 2400, 1, k + 10, T0 + k))
            for k in range(50):
                ing.put("tape", trade(GC_ID, 2400, 1, S.BID, T0 + k * 1000, seq=k))
            while ing.drain_once(block=False):
                pass
        finally:
            M.HARD_QUEUE_LIMIT = old
        self.assertGreater(hub.metrics["droppedForResync"], 0)
        self.assertIn("backlog", hub.take_resync("book"))
        self.assertEqual(hub.roots["GC"].tape.counts["accepted"], 50)  # trades are never shed
        self.assertGreater(hub.metrics["maxQueueDepth"], 100)


if __name__ == "__main__":
    unittest.main()
