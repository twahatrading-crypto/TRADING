"""TLUXE IBKR depth bridge - unit tests. TEST DATA ONLY: the IB Gateway API is replaced by a recording fake;
no IBKR connection, account or credential is used."""
from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tluxe_ibkr_bridge.book import ASK, BID, DELETE, INSERT, UPDATE, BookInconsistent, DepthBook  # noqa: E402
from tluxe_ibkr_bridge.codes import classify, redact  # noqa: E402
from tluxe_ibkr_bridge.config import ConfigError, load_config  # noqa: E402
from tluxe_ibkr_bridge.contracts import Unresolved, select_contract  # noqa: E402
from tluxe_ibkr_bridge.link import Envelope, backoff_s  # noqa: E402
from tluxe_ibkr_bridge.session import RESUBSCRIBE_MIN_S, STALE_AFTER_S, DepthSession  # noqa: E402

TOKEN = "x" * 40


def det(root, local, cls=None, mult=None, exch="COMEX", con=1):
    return {"conId": con, "symbol": root, "localSymbol": local, "secType": "FUT", "exchange": exch, "currency": "USD",
            "tradingClass": cls or root, "multiplier": mult or {"GC": "100", "SI": "5000"}[root], "lastTradeDateOrContractMonth": "20261229", "minTick": 0.1}


class FakeApi:
    def __init__(self):
        self.calls = []

    def request_contract(self, rid, root, local):
        self.calls.append(("contract", rid, root, local))

    def request_depth(self, rid, c, rows):
        self.calls.append(("depth", rid, c.local_symbol, rows))

    def cancel_depth(self, rid):
        self.calls.append(("cancel", rid))


class Clock:
    def __init__(self):
        self.t = 1_800_000_000.0

    def __call__(self):
        return self.t


def live_session(roots=("GC",)):
    api, out, clock = FakeApi(), [], Clock()
    s = DepthSession(api, out.append, roots=roots, rows=5, clock=clock)
    s.on_connected(176)
    s.on_targets({r: {"GC": "GCZ6", "SI": "SIZ6"}[r] for r in roots})
    for c in list(api.calls):
        if c[0] == "contract":
            s.on_contract_details(c[1], det(c[2], c[3], con=462941472 if c[2] == "GC" else 535526329))
            s.on_contract_details_end(c[1])
    depth_req = {c[2][:2]: c[1] for c in api.calls if c[0] == "depth"}
    return s, api, out, clock, depth_req


class BookTests(unittest.TestCase):
    def test_insert_update_delete_follow_ibkr_row_semantics(self):
        b = DepthBook(rows=3)
        self.assertEqual(b.apply(0, INSERT, BID, 100.0, 5), [("bid", 100.0, 5)])
        b.apply(1, INSERT, BID, 99.9, 7)
        # insert at the top shifts rows down
        self.assertEqual(b.apply(0, INSERT, BID, 100.1, 2), [("bid", 100.1, 2)])
        self.assertEqual([r.price for r in b.bids], [100.1, 100.0, 99.9])
        # a 4th insert pushes the last row out of the 3-row book -> that price is removed
        ch = b.apply(0, INSERT, BID, 100.2, 1)
        self.assertIn(("bid", 99.9, 0.0), ch)
        self.assertEqual(b.apply(1, UPDATE, BID, 100.1, 9), [("bid", 100.1, 9)])
        self.assertEqual(b.apply(0, DELETE, BID, 100.2, 0), [("bid", 100.2, 0.0)])
        self.assertEqual(b.snapshot()["bids"], [[100.1, 9], [100.0, 5]])

    def test_operations_that_do_not_fit_the_book_are_inconsistent_never_guessed(self):
        b = DepthBook(rows=5)
        for bad in [(0, UPDATE), (2, DELETE), (3, INSERT)]:
            with self.assertRaises(BookInconsistent):
                b.apply(bad[0], bad[1], ASK, 1.0, 1)
        with self.assertRaises(BookInconsistent):
            b.apply(0, 7, ASK, 1.0, 1)

    def test_duplicate_price_rows_are_not_summed(self):
        b = DepthBook(rows=5)
        b.apply(0, INSERT, ASK, 10.0, 3)
        b.apply(1, INSERT, ASK, 10.0, 4)  # transient duplicate: keep the best row, never 7
        self.assertEqual(b.levels(ASK), {10.0: 3})
        self.assertGreater(b.duplicate_prices, 0)


class ContractTests(unittest.TestCase):
    def test_exact_contract_or_unresolved(self):
        r = select_contract("SI", "SIZ6", [det("SI", "SILZ6", cls="SIL", mult="1000", con=842178357), det("SI", "SIZ6", con=535526329)])
        self.assertEqual((r.con_id, r.local_symbol, r.trading_class, r.multiplier, r.exchange), (535526329, "SIZ6", "SI", "5000", "COMEX"))
        with self.assertRaises(Unresolved):
            select_contract("SI", "SIZ6", [det("SI", "SILZ6", cls="SIL", mult="1000")])  # micro only -> never substituted
        with self.assertRaises(Unresolved):
            select_contract("GC", "GCZ6", [det("GC", "GCZ6"), det("GC", "GCZ6", con=2)])  # ambiguous
        with self.assertRaises(Unresolved):
            select_contract("GC", None, [det("GC", "GCZ6")])  # no target = wait, never pick a front month
        with self.assertRaises(Unresolved):
            select_contract("GC", "GCZ6", [det("GC", "GCZ6", exch="SMART")])


class SessionTests(unittest.TestCase):
    def test_resolves_the_target_contract_then_requests_direct_depth(self):
        s, api, out, _, req = live_session(("GC", "SI"))
        self.assertIn(("contract", api.calls[0][1], "GC", "GCZ6"), api.calls)
        self.assertEqual({c[2] for c in api.calls if c[0] == "depth"}, {"GCZ6", "SIZ6"})
        self.assertTrue(any(m["type"] == "contract" and m["contract"]["conId"] == 462941472 for m in out))
        self.assertEqual(s.roots["GC"].state, "SUBSCRIBING")

    def test_depth_rows_become_sequenced_price_level_changes(self):
        s, api, out, clock, req = live_session()
        s.on_depth(req["GC"], 0, INSERT, BID, 4150.0, 5)
        s.on_depth(req["GC"], 0, INSERT, ASK, 4150.1, 3)
        s.on_depth(req["GC"], 0, UPDATE, BID, 4150.0, 8)
        s.flush()
        d = [m for m in out if m["type"] == "depth"][-1]
        seqs = [c[0] for c in d["changes"]]
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual([c[1:5] for c in d["changes"]], [["bid", 4150.0, 5, "insert"], ["ask", 4150.1, 3, "insert"], ["bid", 4150.0, 8, "update"]])
        self.assertEqual(s.roots["GC"].state, "LIVE")
        self.assertEqual(s.state, "LIVE")
        snap = s.snapshot("GC")
        self.assertEqual((snap["bids"], snap["asks"], snap["valid"]), ([[4150.0, 8]], [[4150.1, 3]], True))

    def test_reset_rules_clear_the_book_first(self):
        s, api, out, clock, req = live_session()
        s.on_depth(req["GC"], 0, INSERT, BID, 4150.0, 5)
        s.on_error(req["GC"], 317, "Market depth data has been RESET")
        self.assertEqual(s.roots["GC"].book.bids, [])
        self.assertEqual(out[-1]["type"], "reset")
        # inconsistent row op -> reset + resubscribe
        n = len([c for c in api.calls if c[0] == "depth"])
        s.on_depth(req["GC"], 4, UPDATE, BID, 1, 1)
        self.assertEqual(out[-1]["type"], "reset")
        self.assertEqual(len([c for c in api.calls if c[0] == "depth"]), n + 1)
        # 1101 / 1102 -> rebuilt from a fresh subscription
        s.on_error(-1, 1102, "restored")
        self.assertEqual(out[-1]["type"], "reset")

    def test_link_down_disconnect_and_auth_required_states(self):
        s, api, out, clock, req = live_session()
        s.on_depth(req["GC"], 0, INSERT, BID, 4150.0, 5)
        s.on_error(-1, 1100, "Connectivity between IB and TWS has been lost")
        self.assertEqual(s.state, "RECONNECTING")
        self.assertEqual(s.roots["GC"].book.bids, [])
        s.on_disconnected("gateway at login screen", auth_required=True)
        self.assertEqual(s.state, "AUTH_REQUIRED")
        self.assertTrue(s.health()["session"]["authRequired"])
        s.on_disconnected("gateway not running")
        self.assertEqual(s.state, "OFFLINE")

    def test_not_entitled_is_reported_never_retried_as_live(self):
        s, api, out, clock, req = live_session()
        s.on_error(req["GC"], 354, "Requested market data is not subscribed")
        self.assertEqual(s.roots["GC"].state, "NOT_ENTITLED")
        self.assertEqual(s.state, "NOT_ENTITLED")
        s.on_depth(req["GC"], 0, INSERT, BID, 1, 1)  # a cancelled request is never applied
        self.assertEqual(s.roots["GC"].book.bids, [])

    def test_stale_clears_and_resubscribes(self):
        s, api, out, clock, req = live_session()
        s.on_depth(req["GC"], 0, INSERT, BID, 4150.0, 5)
        clock.t += STALE_AFTER_S + 1
        s.tick()
        self.assertEqual(s.roots["GC"].state, "STALE")
        self.assertEqual(s.roots["GC"].book.bids, [])
        self.assertEqual(s.snapshot("GC")["valid"], False)
        clock.t += RESUBSCRIBE_MIN_S + 1
        n = len([c for c in api.calls if c[0] == "depth"])
        s.tick()
        self.assertEqual(len([c for c in api.calls if c[0] == "depth"]), n + 1)

    def test_contract_change_resets_and_never_mixes_contracts(self):
        s, api, out, clock, req = live_session()
        s.on_depth(req["GC"], 0, INSERT, BID, 4150.0, 5)
        s.on_targets({"GC": "GCG7"})
        self.assertEqual(s.roots["GC"].book.bids, [])
        self.assertTrue(any(m["type"] == "reset" and "GCZ6 -> GCG7" in m["reason"] for m in out))
        self.assertIn(("cancel", req["GC"]), api.calls)
        s.on_depth(req["GC"], 0, INSERT, BID, 4150.0, 5)  # late row of the old contract: ignored
        self.assertEqual(s.roots["GC"].book.bids, [])

    def test_error_codes(self):
        self.assertEqual(classify(10092).action, "NOT_ENTITLED")
        self.assertEqual(classify(317).action, "RESET_ROOT")
        self.assertEqual(classify(2104).action, "INFO")
        self.assertEqual(classify(1100).action, "LINK_DOWN")
        self.assertEqual(classify(999999).action, "UNKNOWN")
        self.assertEqual(redact("account DU1234567 and U7654321 not allowed"), "account [account] and [account] not allowed")

    def test_error_text_is_redacted_before_it_is_kept(self):
        s, api, out, clock, req = live_session()
        s.on_error(req["GC"], 10090, "Part of data not subscribed for account U1234567")
        self.assertNotIn("U1234567", json.dumps(s.health()))


class ConfigAndLinkTests(unittest.TestCase):
    def test_config_safety(self):
        base = {"TLUXE_IBKR_GATEWAY_URL": "wss://example.test/bridge/ibkr", "TLUXE_IBKR_BRIDGE_TOKEN": TOKEN}
        cfg = load_config(base)
        self.assertEqual((cfg.ib_host, cfg.ib_port, cfg.rows, cfg.roots), ("127.0.0.1", 4001, 10, ("GC", "SI")))
        self.assertNotIn(TOKEN, repr(cfg))
        for bad in [{"TLUXE_IBKR_HOST": "10.0.0.5"}, {"TLUXE_IBKR_BRIDGE_TOKEN": "short"}, {"TLUXE_IBKR_GATEWAY_URL": "ws://example.test/bridge/ibkr"},
                    {"TLUXE_IBKR_ROOTS": "GC,ES"}, {"TLUXE_IBKR_DEPTH_ROWS": "0"}]:
            with self.assertRaises(ConfigError):
                load_config({**base, **bad})
        load_config({**base, "TLUXE_IBKR_GATEWAY_URL": "ws://127.0.0.1:8780/bridge/ibkr"})  # loopback test gateway only

    def test_envelope_rejects_replay_and_skew(self):
        clock = Clock()
        env = Envelope(clock)
        m = json.loads(env.wrap({"type": "x"}))
        self.assertEqual(m["seq"], 1)
        rx = Envelope(clock)
        now = int(clock.t * 1000)
        self.assertTrue(rx.accept({"seq": 1, "ts": now}))
        self.assertFalse(rx.accept({"seq": 1, "ts": now}))
        self.assertFalse(rx.accept({"seq": 2, "ts": now - 60_000}))
        self.assertLessEqual(backoff_s(20, lambda: 1.0), 60.0)


class SafetyTests(unittest.TestCase):
    def test_no_order_methods_and_ibapi_only_in_the_adapter(self):
        src = Path(__file__).resolve().parent.parent / "tluxe_ibkr_bridge"
        for f in src.glob("*.py"):
            text = f.read_text(encoding="utf-8")
            self.assertIsNone(re.search(r"\b(placeOrder|cancelOrder|reqGlobalCancel|reqAccountUpdates|reqPositions|reqAccountSummary|exerciseOptions)\b", text), f.name)
            if f.name not in ("ib_adapter.py", "capture.py"):
                self.assertNotIn("from ibapi", text, f.name)


if __name__ == "__main__":
    unittest.main()
