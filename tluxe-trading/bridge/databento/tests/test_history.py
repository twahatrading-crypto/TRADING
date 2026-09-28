"""Databento historical OHLCV + timeframe assembly + contract rollover. TEST DATA ONLY: hand-built dbn records and a
scripted Historical client (no network, no cost). The live bridge never uses these."""
import unittest

import databento_dbn as dbn
from fixtures import GC_ID, KEY, P, S, T0, bar, cfg, mapping, trade

from tluxe_databento_bridge.history import (COST_BLOCKED, NOT_ENTITLED, READY, HistoryLoader, HistoryStore, aggregate, assemble)
from tluxe_databento_bridge.hub import Hub

GC2 = 42099
DAY = 86_400


def hbar(iid: int, t_sec: int, o: float, h: float, lo: float, c: float, v: int, rtype=dbn.RType.OHLCV_1M) -> dbn.OHLCVMsg:
    return dbn.OHLCVMsg(rtype=rtype, publisher_id=1, instrument_id=iid, ts_event=t_sec * P, open=round(o * P), high=round(h * P), low=round(lo * P),
                        close=round(c * P), volume=v)


class FakeHistorical:
    """Scripted Databento Historical client (TEST ONLY)."""

    def __init__(self, bars: dict, cost: float = 0.01, error: str | None = None, end: str = "2026-09-28T06:00:00.000000000Z") -> None:
        self.bars, self.cost, self.error, self.end = bars, cost, error, end
        self.calls: list = []
        outer = self

        class Meta:
            def get_dataset_range(self, dataset):
                return {"start": "2010-06-06T00:00:00.000000000Z", "end": outer.end}

            def get_cost(self, **kw):
                outer.calls.append(("cost", kw["schema"], tuple(kw["symbols"]), kw["stype_in"]))
                return outer.cost / 3

        class Series:
            def get_range(self, **kw):
                outer.calls.append(("get", kw["schema"], tuple(kw["symbols"]), kw["stype_in"]))
                if outer.error:
                    raise RuntimeError(outer.error)
                return list(outer.bars.get(kw["schema"], []))

        self.metadata, self.timeseries = Meta(), Series()


def m1(t, c, v=1):
    return {"time": t, "open": c, "high": c + 1, "low": c - 1, "close": c, "volume": v, "isClosed": True}


class TestAggregation(unittest.TestCase):
    def test_utc_aligned_deterministic_and_closed_only_when_window_complete(self):
        t0 = 1_790_000_400  # 00:00 of a 5-minute bucket? align explicitly:
        t0 -= t0 % 900
        bars = [m1(t0 + i * 60, 100 + i, v=i + 1) for i in range(20)]  # 20 minutes
        out = aggregate(bars, 900, closed_until=t0 + 20 * 60)
        self.assertEqual([b["time"] for b in out], [t0, t0 + 900])
        self.assertEqual((out[0]["open"], out[0]["close"], out[0]["high"], out[0]["low"], out[0]["volume"]), (100, 114, 115, 99, sum(range(1, 16))))
        self.assertTrue(out[0]["isClosed"])
        self.assertFalse(out[1]["isClosed"])  # only 5 of 15 minutes elapsed - never presented as closed
        self.assertEqual(aggregate(bars, 900, closed_until=t0 + 20 * 60), out)  # deterministic

    def test_no_future_leakage_bar_closed_only_after_its_window(self):
        t0 = 1_790_000_000 - 1_790_000_000 % 3600
        bars = [m1(t0 + i * 60, 100) for i in range(60)]
        self.assertFalse(aggregate(bars, 3600, closed_until=t0 + 59 * 60)[0]["isClosed"])
        self.assertTrue(aggregate(bars, 3600, closed_until=t0 + 60 * 60)[0]["isClosed"])

    def test_native_history_only_before_m1_coverage_and_partial_h4_head_dropped(self):
        d0 = 1_789_948_800  # a UTC midnight
        hist = {"ohlcv-1h": {d0 + h * 3600: m1(d0 + h * 3600, 200 + h) for h in range(1, 30)}, "ohlcv-1d": {d0 - DAY: m1(d0 - DAY, 190)}}
        start = d0 + 26 * 3600 + 1800  # M1 coverage starts mid-hour
        series = [m1(start + i * 60, 300 + i) for i in range(120)]
        h1 = assemble("H1", series, hist, closed_until=series[-1]["time"] + 60)
        boundary = d0 + 27 * 3600
        self.assertTrue(all(b["time"] < boundary for b in h1 if b["close"] < 300))  # native bars end where M1 takes over
        self.assertEqual([b["time"] for b in h1 if b["time"] >= boundary][:2], [boundary, boundary + 3600])
        self.assertEqual(len({b["time"] for b in h1}), len(h1))  # never two bars for one hour
        h4 = assemble("H4", series, hist, closed_until=series[-1]["time"] + 60)
        self.assertEqual(h4[0]["time"] % 14400, 0)
        self.assertGreaterEqual(h4[0]["time"], d0 + 4 * 3600)  # the 00:00-04:00 window started at 01:00 -> dropped
        d1 = assemble("D1", series, hist, closed_until=series[-1]["time"] + 60)
        self.assertEqual(d1[0]["time"], d0 - DAY)


class TestLoader(unittest.TestCase):
    def store(self):
        return HistoryStore("GC", "GCZ6", GC_ID)

    def test_loads_only_the_current_contract_raw_symbol_and_ignores_other_instruments(self):
        c = cfg(TLUXE_DB_HISTORY="1")
        fake = FakeHistorical({"ohlcv-1m": [hbar(GC_ID, 1_790_000_000, 1, 2, 0.5, 1.5, 7), hbar(GC2, 1_790_000_060, 9, 9, 9, 9, 9)],
                               "ohlcv-1h": [hbar(GC_ID, 1_789_996_400, 1, 2, 0.5, 1.5, 70, dbn.RType.OHLCV_1H)], "ohlcv-1d": []})
        done = []
        st = HistoryLoader(c, done.append, client_factory=lambda: fake).load(self.store())
        self.assertEqual(st.state, READY)
        self.assertEqual({k: len(v) for k, v in st.bars.items()}, {"ohlcv-1m": 1, "ohlcv-1h": 1, "ohlcv-1d": 0})
        self.assertTrue(all(call[2] == ("GCZ6",) and call[3] == "raw_symbol" for call in fake.calls))
        self.assertEqual([c_[0] for c_ in fake.calls[:3]], ["cost", "cost", "cost"])  # cost estimated BEFORE any download
        self.assertIs(done[0], st)

    def test_cost_guard_blocks_download(self):
        fake = FakeHistorical({}, cost=5.0)
        st = HistoryLoader(cfg(TLUXE_DB_HISTORY="1", TLUXE_DB_HIST_MAX_COST_USD="1"), lambda s: None, client_factory=lambda: fake).load(self.store())
        self.assertEqual(st.state, COST_BLOCKED)
        self.assertFalse(any(c_[0] == "get" for c_ in fake.calls))
        self.assertIn("HISTORICAL DATA UNAVAILABLE", st.message)

    def test_entitlement_rejection_reported_and_key_redacted(self):
        fake = FakeHistorical({}, error=f"403 Not authorized for ohlcv-1m schema (key {KEY})")
        st = HistoryLoader(cfg(TLUXE_DB_HISTORY="1"), lambda s: None, client_factory=lambda: fake).load(self.store())
        self.assertEqual(st.state, NOT_ENTITLED)
        self.assertNotIn(KEY, st.message)
        self.assertEqual(sum(len(v) for v in st.bars.values()), 0)


class TestHubHistoryAndRollover(unittest.TestCase):
    def test_history_merges_with_live_and_a_roll_never_mixes_contracts(self):
        hub = Hub(cfg(TLUXE_DB_HISTORY="1"))
        started = []
        hub.on_contract = started.append
        hub.on_session_connected("tape")
        hub.on_record("tape", mapping("GC.v.0", "GCZ6", GC_ID), hub.now())
        self.assertEqual((started[0].contract, started[0].instrument_id), ("GCZ6", GC_ID))
        t_live = T0 // 1_000_000_000 - T0 // 1_000_000_000 % 60
        store = hub.roots["GC"].history
        for i in range(3):  # three historical minutes just before the live bar
            store.add("ohlcv-1m", hbar(GC_ID, t_live - (3 - i) * 60, 10 + i, 11 + i, 9 + i, 10 + i, 5))
        store.state = READY
        hub.history_loaded(store)
        hub.on_record("tape", bar(GC_ID, t_live, 20, 21, 19, 20, 7), hub.now())
        hub.on_record("tape", trade(GC_ID, 20.5, 2, S.BID, (t_live + 60) * P + 1), hub.now())
        c = hub.candles("GC", "M1", 50)
        self.assertEqual([b["time"] for b in c["bars"]], [t_live - 180, t_live - 120, t_live - 60, t_live, t_live + 60])
        self.assertEqual([b["isClosed"] for b in c["bars"]], [True, True, True, True, False])  # forming bar from real trades
        self.assertEqual(c["history"], READY)
        # ROLL to a new contract: the old contract's history and bars are gone; the new contract loads its own.
        hub.on_record("tape", mapping("GC.v.0", "GCG7", GC2, ts=T0 + 10 * P), hub.now())
        self.assertEqual(started[-1].contract, "GCG7")
        c2 = hub.candles("GC", "M1", 50)
        self.assertEqual((c2["contract"], c2["instrumentId"], c2["bars"]), ("GCG7", GC2, []))
        old = store
        old.add("ohlcv-1m", hbar(GC_ID, t_live + 600, 1, 1, 1, 1, 1))
        hub.history_loaded(old)  # a late download for the OLD contract is ignored
        self.assertEqual(hub.candles("GC", "M1", 50)["bars"], [])
        self.assertEqual(hub.roots["GC"].counts["rolls"], 1)

    def test_history_disabled_is_reported_not_faked(self):
        hub = Hub(cfg())
        hub.on_record("tape", mapping("GC.v.0", "GCZ6", GC_ID), hub.now())
        self.assertEqual(hub.roots["GC"].history.state, "DISABLED")
        self.assertEqual(hub.candles("GC", "H4", 10)["bars"], [])
