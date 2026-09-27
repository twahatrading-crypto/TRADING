"""Deterministic tests: config / secrets, MBO book, snapshot validity, symbology & rolls, trade tape & replay
de-duplication, candles, hub status, GC/SI isolation. TEST DATA ONLY (see fixtures.py)."""
import unittest
from pathlib import Path

from fixtures import GC2_ID, GC_ID, KEY, SI_ID, T0, TOKEN, A, S, bar, cfg, heartbeat, mapping, mbo, snapshot, trade

from tluxe_databento_bridge.book import DEGRADED, INVALID, SYNCING, VALID, OrderBook
from tluxe_databento_bridge.config import ConfigError, from_env
from tluxe_databento_bridge.hub import Hub

HERE = Path(__file__).resolve().parents[1]
MS0 = T0 // 1_000_000


class Clock:
    def __init__(self) -> None:
        self.t = MS0 + 10

    def __call__(self) -> int:
        return self.t


def live_hub(**over):
    clock = Clock()
    h = Hub(cfg(**over), clock=clock)
    for sess in ("book", "tape"):
        h.on_session_connected(sess)
        h.on_record(sess, mapping("GC.v.0", "GCZ6", GC_ID))
        h.on_record(sess, mapping("SI.v.0", "SIZ6", SI_ID))
    return h, clock


class TestConfig(unittest.TestCase):
    def test_missing_key_fails_closed(self):
        with self.assertRaises(ConfigError) as cm:
            from_env({"TLUXE_DB_BRIDGE_TOKEN": TOKEN})
        self.assertIn("DATABENTO_API_KEY", str(cm.exception))
        with self.assertRaises(ConfigError):
            from_env({"DATABENTO_API_KEY": "   ", "TLUXE_DB_BRIDGE_TOKEN": TOKEN})

    def test_bridge_token_rules_and_no_secret_in_messages(self):
        with self.assertRaises(ConfigError) as cm:
            from_env({"DATABENTO_API_KEY": KEY, "TLUXE_DB_BRIDGE_TOKEN": "short"})
        self.assertNotIn(KEY, str(cm.exception))
        with self.assertRaises(ConfigError):
            from_env({"DATABENTO_API_KEY": KEY + "x" * 10, "TLUXE_DB_BRIDGE_TOKEN": KEY + "x" * 10})

    def test_secrets_never_in_repr(self):
        c = cfg()
        for text in (repr(c), str(c), repr(c.api_key), str(c.token)):
            self.assertNotIn(KEY, text)
            self.assertNotIn(TOKEN, text)

    def test_all_interfaces_refused(self):
        with self.assertRaises(ConfigError):
            cfg(TLUXE_DB_BRIDGE_HOST="0.0.0.0")

    def test_auto_and_manual_contract_modes(self):
        self.assertEqual(cfg().symbol_for("GC"), ("GC.v.0", "continuous"))
        self.assertEqual(cfg().symbol_for("SI"), ("SI.v.0", "continuous"))
        m = cfg(TLUXE_DB_CONTRACT_MODE="manual", TLUXE_DB_CONTRACT_GC="GCZ6", TLUXE_DB_CONTRACT_SI="SIH7")
        self.assertEqual(m.symbol_for("GC"), ("GCZ6", "raw_symbol"))
        with self.assertRaises(ConfigError):
            cfg(TLUXE_DB_CONTRACT_MODE="manual", TLUXE_DB_CONTRACT_GC="SIZ6", TLUXE_DB_CONTRACT_SI="SIZ6")

    def test_env_example_has_placeholders_only_and_env_is_gitignored(self):
        ex = (HERE / ".env.example").read_text()
        self.assertIn("DATABENTO_API_KEY=\n", ex)
        for line in ex.splitlines():
            if line.startswith(("DATABENTO_API_KEY=", "TLUXE_DB_BRIDGE_TOKEN=")):
                self.assertEqual(line.split("=", 1)[1], "")
        self.assertIn(".env", (HERE / ".gitignore").read_text().splitlines())


class TestBook(unittest.TestCase):
    def book(self):
        b = OrderBook(GC_ID)
        for r in snapshot(GC_ID, [(S.BID, 2400.0, 5, 1), (S.BID, 2399.9, 3, 2), (S.ASK, 2400.1, 7, 3)]):
            b.apply(r)
        return b

    def test_snapshot_not_valid_until_last_snapshot_record(self):
        b = OrderBook(GC_ID)
        recs = snapshot(GC_ID, [(S.BID, 2400.0, 5, 1), (S.ASK, 2400.1, 7, 2), (S.ASK, 2400.2, 1, 3)])
        for r in recs[:-1]:
            b.apply(r)
            self.assertEqual(b.state, SYNCING)
            self.assertFalse(b.publishable)
        b.apply(recs[-1])
        self.assertEqual(b.state, VALID)
        self.assertTrue(b.publishable)
        self.assertEqual(b.epoch, 1)

    def test_live_records_without_snapshot_are_invalid(self):
        b = OrderBook(GC_ID)
        b.apply(mbo(GC_ID, A.ADD, S.BID, 2400, 5, 1, T0))
        self.assertEqual(b.state, INVALID)
        self.assertFalse(b.publishable)

    def test_add_modify_cancel_clear_and_levels(self):
        b = self.book()
        b.apply(mbo(GC_ID, A.ADD, S.BID, 2400.0, 4, 10, T0 + 100))
        self.assertEqual(b.snapshot()["bids"][0], [2400.0, 9, 2])
        b.apply(mbo(GC_ID, A.MODIFY, S.BID, 2400.0, 6, 10, T0 + 101))  # size increase
        self.assertEqual(b.snapshot()["bids"][0], [2400.0, 11, 2])
        b.apply(mbo(GC_ID, A.MODIFY, S.BID, 2399.8, 6, 10, T0 + 102))  # price move
        self.assertEqual(b.snapshot()["bids"], [[2400.0, 5, 1], [2399.9, 3, 1], [2399.8, 6, 1]])
        b.apply(mbo(GC_ID, A.CANCEL, S.BID, 2399.8, 2, 10, T0 + 103))  # partial cancel
        self.assertEqual(b.snapshot()["bids"][-1], [2399.8, 4, 1])
        b.apply(mbo(GC_ID, A.CANCEL, S.BID, 2399.8, 4, 10, T0 + 104))  # full cancel
        self.assertEqual(len(b.snapshot()["bids"]), 2)
        self.assertNotIn(10, b.orders)
        b.apply(mbo(GC_ID, A.CLEAR, S.NONE, 0, 0, 0, T0 + 105))
        self.assertEqual(b.snapshot(), {"bids": [], "asks": []})
        self.assertEqual(b.state, VALID)

    def test_trade_fill_none_do_not_change_book(self):
        b = self.book()
        before = b.snapshot()
        for act in (A.TRADE, A.FILL, A.NONE):
            b.apply(mbo(GC_ID, act, S.ASK, 2400.1, 7, 3, T0 + 200))
        self.assertEqual(b.snapshot(), before)

    def test_side_none_and_modify_of_unknown_order(self):
        b = self.book()
        b.apply(mbo(GC_ID, A.ADD, S.NONE, 2401, 1, 99, T0 + 1))
        self.assertNotIn(99, b.orders)
        b.apply(mbo(GC_ID, A.MODIFY, S.ASK, 2400.3, 2, 77, T0 + 2))  # applied as add (Databento reference)
        self.assertEqual(b.orders[77].size, 2)

    def test_cancel_of_missing_order_degrades(self):
        b = self.book()
        b.apply(mbo(GC_ID, A.CANCEL, S.BID, 2400, 1, 555, T0 + 1))
        self.assertEqual(b.state, DEGRADED)
        self.assertEqual(b.counts["anomalies"], 1)

    def test_maybe_bad_book_and_out_of_order_sequence_degrade(self):
        b = self.book()
        b.apply(mbo(GC_ID, A.ADD, S.BID, 2400, 1, 11, T0 + 1, flags=128 | 4, seq=10))
        self.assertEqual(b.state, DEGRADED)
        b2 = self.book()
        b2.apply(mbo(GC_ID, A.ADD, S.BID, 2400, 1, 11, T0 + 1, seq=10))
        b2.apply(mbo(GC_ID, A.ADD, S.BID, 2400, 1, 12, T0 + 2, seq=9))
        self.assertEqual(b2.state, DEGRADED)
        self.assertEqual(b2.counts["outOfOrder"], 1)

    def test_malformed_record_degrades(self):
        b = self.book()
        r = mbo(GC_ID, A.ADD, S.BID, 2400, 1, 13, T0 + 1)
        import databento_dbn as dbn

        bad = dbn.MBOMsg(publisher_id=1, instrument_id=GC_ID, ts_event=r.ts_event, order_id=13, price=9223372036854775807, size=1, action=A.ADD, side=S.BID, ts_recv=r.ts_recv, flags=128)
        b.apply(bad)
        self.assertEqual(b.state, DEGRADED)
        self.assertEqual(b.counts["malformed"], 1)
        self.assertNotIn(13, b.orders)

    def test_not_published_mid_event(self):
        b = self.book()
        b.apply(mbo(GC_ID, A.ADD, S.BID, 2400, 1, 20, T0 + 1, flags=0))
        self.assertFalse(b.publishable)
        b.apply(mbo(GC_ID, A.ADD, S.BID, 2400, 1, 21, T0 + 1, flags=128))
        self.assertTrue(b.publishable)


class TestHub(unittest.TestCase):
    def test_mapping_gives_actual_contracts_and_isolated_roots(self):
        h, _ = live_hub()
        self.assertEqual((h.roots["GC"].contract, h.roots["GC"].instrument_id), ("GCZ6", GC_ID))
        self.assertEqual((h.roots["SI"].contract, h.roots["SI"].instrument_id), ("SIZ6", SI_ID))
        for r in snapshot(GC_ID, [(S.BID, 2400.0, 5, 1)]):
            h.on_record("book", r)
        h.on_record("tape", trade(SI_ID, 31.2, 2, S.ASK, T0 + 5))
        self.assertEqual(h.roots["GC"].book.state, VALID)
        self.assertEqual(h.roots["SI"].book.state, SYNCING)  # SI's book is untouched by GC records
        self.assertEqual(h.roots["GC"].tape.counts["accepted"], 0)
        self.assertEqual(h.roots["SI"].tape.counts["accepted"], 1)
        st = h.health()["instruments"]
        self.assertEqual(st["GC"]["contract"], "GCZ6")
        self.assertEqual(st["SI"]["contract"], "SIZ6")

    def test_unmapped_instrument_is_counted_never_applied(self):
        h, _ = live_hub()
        h.on_record("tape", trade(99999, 1.0, 1, S.BID, T0))
        self.assertEqual(h.metrics["unmapped"], 1)

    def test_syncing_until_snapshot_then_live(self):
        h, _ = live_hub()
        self.assertEqual(h.root_status(h.roots["GC"])["status"], "SYNCING")
        for r in snapshot(GC_ID, [(S.BID, 2400.0, 5, 1), (S.ASK, 2400.1, 5, 2)]):
            h.on_record("book", r, MS0 + 10)
        self.assertEqual(h.root_status(h.roots["GC"])["status"], "LIVE")

    def test_contract_roll_resets_state_and_is_audited(self):
        h, _ = live_hub()
        for r in snapshot(GC_ID, [(S.BID, 2400.0, 5, 1)]):
            h.on_record("book", r)
        h.on_record("tape", trade(GC_ID, 2400.0, 3, S.BID, T0 + 5))
        h.on_record("tape", bar(GC_ID, T0 // 10**9 // 60 * 60, 2400, 2401, 2399, 2400.5, 10))
        h.on_record("book", mapping("GC.v.0", "GCG7", GC2_ID, T0 + 10**12))
        gc = h.roots["GC"]
        self.assertEqual((gc.contract, gc.instrument_id), ("GCG7", GC2_ID))
        self.assertEqual(gc.book.state, SYNCING)
        self.assertEqual(len(gc.book.orders), 0)
        self.assertEqual(gc.tape.contract, "GCG7")
        self.assertEqual(gc.tape.counts["accepted"], 0)
        self.assertEqual(len(gc.candles.bars), 0)
        self.assertEqual(h.symmap.rolls[-1]["from"], "GCZ6")
        self.assertEqual(h.symmap.rolls[-1]["to"], "GCG7")
        self.assertIn("roll", h.take_resync("book"))
        self.assertIn("roll", h.take_resync("tape"))
        # Records of the OLD contract are never applied to the new one.
        h.on_record("tape", trade(GC_ID, 2400.0, 3, S.BID, T0 + 6))
        self.assertEqual(gc.tape.counts["accepted"], 0)
        # Same mapping again (other session) is not a second roll.
        h.on_record("tape", mapping("GC.v.0", "GCG7", GC2_ID, T0 + 10**12))
        self.assertEqual(len(h.symmap.rolls), 1)

    def test_duplicate_mbo_record_dropped(self):
        h, _ = live_hub()
        recs = snapshot(GC_ID, [(S.BID, 2400.0, 5, 1)])
        for r in recs:
            h.on_record("book", r)
        add = mbo(GC_ID, A.ADD, S.BID, 2400.0, 2, 50, T0 + 100, seq=7)
        h.on_record("book", add)
        h.on_record("book", add)
        self.assertEqual(h.roots["GC"].counts["mboDuplicates"], 1)
        self.assertEqual(h.roots["GC"].book.snapshot()["bids"][0], [2400.0, 7, 2])

    def test_disconnect_freezes_book_then_resnapshot(self):
        h, _ = live_hub()
        for r in snapshot(GC_ID, [(S.BID, 2400.0, 5, 1)]):
            h.on_record("book", r)
        h.on_session_closed("book", reconnecting=True)
        gc = h.roots["GC"]
        self.assertEqual(gc.book.state, SYNCING)
        self.assertEqual(h.root_status(gc)["status"], "RECONNECTING")
        self.assertEqual(h.root_status(gc)["freshness"], "OFFLINE")
        self.assertIsNone(h.book_snapshot("GC")["book"])  # never served as live
        h.on_session_connected("book")
        for r in snapshot(GC_ID, [(S.ASK, 2401.0, 9, 5)], ts=T0 + 10**9):
            h.on_record("book", r, MS0 + 10)
        self.assertEqual(gc.book.state, VALID)
        self.assertEqual(h.book_snapshot("GC")["book"]["asks"], [[2401.0, 9, 1]])

    def test_stale_when_no_message_including_heartbeats(self):
        h, clock = live_hub()
        for r in snapshot(GC_ID, [(S.BID, 2400.0, 5, 1)]):
            h.on_record("book", r, MS0 + 10)
        h.on_record("tape", heartbeat(T0), MS0 + 10)
        self.assertEqual(h.root_status(h.roots["GC"])["status"], "LIVE")
        clock.t += 60_000
        st = h.root_status(h.roots["GC"])
        self.assertEqual(st["status"], "STALE")
        self.assertEqual(st["freshness"], "STALE")
        h.on_record("book", heartbeat(T0), clock.t)
        h.on_record("tape", heartbeat(T0), clock.t)
        self.assertEqual(h.root_status(h.roots["GC"])["status"], "LIVE")

    def test_consumer_lag_marks_degraded(self):
        h, clock = live_hub()
        for r in snapshot(GC_ID, [(S.BID, 2400.0, 5, 1)]):
            h.on_record("book", r, MS0 + 10)
        h.on_record("tape", heartbeat(T0), MS0 + 10)
        h.on_record("book", mbo(GC_ID, A.ADD, S.BID, 2400, 1, 60, T0 + 5), MS0 + 9_000)  # processed 9 s after ts_recv
        st = h.root_status(h.roots["GC"])
        self.assertEqual(st["status"], "DEGRADED")
        self.assertEqual(st["freshness"], "DELAYED")

    def test_auth_error_and_entitlement(self):
        h, _ = live_hub()
        h.on_error("book", f"Authentication failed for key {KEY}", fatal=True)
        st = h.health()
        self.assertEqual(st["instruments"]["GC"]["status"], "AUTH_ERROR")
        self.assertNotIn(KEY, str(st))
        h2, _ = live_hub()
        h2.on_error("tape", "User is not entitled to dataset", fatal=True)
        self.assertEqual(h2.health()["instruments"]["SI"]["status"], "UNAVAILABLE")

    def test_frames_batch_and_cursor_reset(self):
        h, _ = live_hub(TLUXE_DB_MAX_FRAMES="60")
        for r in snapshot(GC_ID, [(S.BID, 2400.0, 5, 1)]):
            h.on_record("book", r)
        f1 = h.publish()
        self.assertIn("snapshot", f1["instruments"]["GC"])
        for k in range(100):  # 100 book changes, coalesced into one frame
            h.on_record("book", mbo(GC_ID, A.ADD, S.BID, 2399.0, 1, 1000 + k, T0 + 10 + k))
        f2 = h.publish()
        self.assertEqual(f2["instruments"]["GC"]["levels"], [["B", 2399.0, 100]])
        self.assertEqual([f["cursor"] for f in h.frames_after(1)["frames"]], [2])
        for _ in range(80):
            h.publish()
        self.assertTrue(h.frames_after(1)["reset"])  # client fell behind the bounded ring -> must resync


class TestTape(unittest.TestCase):
    def test_aggressor_from_source_side_only(self):
        h, _ = live_hub()
        h.on_record("tape", trade(GC_ID, 2400.1, 3, S.BID, T0 + 1))  # buyer initiated -> ASK volume
        h.on_record("tape", trade(GC_ID, 2400.0, 2, S.ASK, T0 + 2))  # seller initiated -> BID volume
        h.on_record("tape", trade(GC_ID, 2400.0, 4, S.NONE, T0 + 3))  # unknown stays UNKNOWN
        tape = h.roots["GC"].tape
        self.assertEqual([t["aggressor"] for t in tape.trades], ["BUY", "SELL", "UNKNOWN"])
        self.assertEqual(tape.volume, {"buy": 3, "sell": 2, "unknown": 4})

    def test_replay_after_reconnect_never_double_counts(self):
        h, _ = live_hub()
        original = [trade(GC_ID, 2400 + k * 0.1, 1 + k % 3, S.BID if k % 2 else S.ASK, T0 + k * 10**9, seq=k) for k in range(100)]
        for r in original:
            h.on_record("tape", r)
        h.on_record("tape", trade(SI_ID, 31.0, 1, S.BID, original[-1].ts_event))  # SI has history too
        vol = dict(h.roots["GC"].tape.volume)
        start = h.tape_replay_start_ns()
        self.assertEqual(start, original[-1].ts_event - 60 * 10**9)
        h.on_session_closed("tape", reconnecting=True)
        h.on_session_connected("tape")  # new session: occurrence counting restarts
        replay = [r for r in original if r.ts_event >= start] + [trade(GC_ID, 2410, 5, S.BID, T0 + 200 * 10**9, seq=200)]
        for r in replay:
            h.on_record("tape", r)
        tape = h.roots["GC"].tape
        self.assertEqual(tape.counts["duplicates"], len(replay) - 1)
        self.assertEqual(tape.volume["buy"], vol["buy"] + 5)
        self.assertEqual(tape.volume["sell"], vol["sell"])
        self.assertEqual(tape.counts["accepted"], 101)

    def test_identical_genuine_prints_are_kept(self):
        h, _ = live_hub()
        r = trade(GC_ID, 2400, 1, S.BID, T0 + 1, seq=5)
        h.on_record("tape", r)
        h.on_record("tape", r)  # same event printed twice in one session = two real prints (occurrence 0 / 1)
        self.assertEqual(h.roots["GC"].tape.counts["accepted"], 2)
        h.on_session_connected("tape")
        h.on_record("tape", r)
        h.on_record("tape", r)  # the replay of both -> both dropped
        self.assertEqual(h.roots["GC"].tape.counts["accepted"], 2)
        self.assertEqual(h.roots["GC"].tape.counts["duplicates"], 2)

    def test_malformed_trade(self):
        h, _ = live_hub()
        import databento_dbn as dbn

        h.on_record("tape", dbn.TradeMsg(publisher_id=1, instrument_id=GC_ID, ts_event=T0, price=9223372036854775807, size=1, action=A.TRADE, side=S.BID, depth=0, ts_recv=T0, flags=0))
        self.assertEqual(h.roots["GC"].tape.counts["malformed"], 1)
        self.assertEqual(h.roots["GC"].tape.counts["accepted"], 0)

    def test_outage_longer_than_replay_window_is_a_gap(self):
        h, clock = live_hub()
        h.on_record("tape", trade(GC_ID, 2400, 1, S.BID, T0))
        clock.t += 30 * 3_600_000
        h.tape_replay_start_ns()
        self.assertEqual(h.roots["GC"].counts["tapeGaps"], 1)
        self.assertEqual(h.root_status(h.roots["GC"])["tape"]["contract"], "GCZ6")

    def test_candles_current_contract_real_volume(self):
        h, _ = live_hub()
        m = T0 // 10**9 // 60 * 60
        for k in range(10):
            h.on_record("tape", bar(GC_ID, m + 60 * k, 2400, 2401, 2399, 2400.5, 10 + k))
        h.on_record("tape", bar(GC2_ID, m, 1, 1, 1, 1, 999))  # another contract: never merged
        c = h.candles("GC", "M1", 100)
        self.assertEqual(len(c["bars"]), 10)
        self.assertEqual(c["contract"], "GCZ6")
        self.assertEqual(sum(b["volume"] for b in c["bars"]), sum(10 + k for k in range(10)))
        m5 = h.candles("GC", "M5", 100)["bars"]
        self.assertEqual(sum(b["volume"] for b in m5), sum(10 + k for k in range(10)))


if __name__ == "__main__":
    unittest.main()
