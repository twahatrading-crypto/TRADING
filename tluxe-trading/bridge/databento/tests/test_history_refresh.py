"""Historical refresh: does healthy operation still open a gap?

These tests drive a FAKE Databento client and a simulated clock. No network call is
made, no credential is read, and the fixtures are never served as market data.

The central test is `test_72h_healthy_operation_opens_no_gap`: it reproduces the
fault first (to prove the test can fail) and then shows the refresh closing it.
"""
from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tluxe_databento_bridge.history import (  # noqa: E402
    AUTH_ERROR, COST_BLOCKED, HistoryLoader, HistoryRefresher, HistoryStore, READY, UNAVAILABLE,
)

MIN = 60
HOUR = 3600
INSTRUMENT = 4242
IIDS = {"GCZ6": INSTRUMENT, "SIZ6": INSTRUMENT + 1}


# --------------------------------------------------------------------------- fakes
class FakeRec:
    """Shaped like a Databento ohlcv record; values are arbitrary but coherent."""

    def __init__(self, t: int, instrument_id: int = INSTRUMENT) -> None:
        self.ts_event = t * 1_000_000_000
        self.instrument_id = instrument_id
        self.open = self.high = self.low = self.close = 4000_000_000_000
        self.high += 1_000_000_000
        self.volume = 10


class FakeClient:
    """A Databento Historical stand-in whose coverage ends at a controllable instant."""

    def __init__(self, clock, traded, cost=0.0, fail=None, iids=None) -> None:
        self.clock, self.traded, self.cost, self.fail = clock, traded, cost, fail
        # contract -> instrument id. A store refuses a record carrying another
        # contract's id, so a multi-root test must answer with the right one.
        self.iids = iids or {}
        self.calls = 0

    class _Meta:
        def __init__(self, outer):
            self.outer = outer

        def get_dataset_range(self, dataset):
            return {"end": _iso(self.outer.clock())}

        def get_cost(self, **kw):
            return self.outer.cost

    @property
    def metadata(self):
        return FakeClient._Meta(self)

    class _TS:
        def __init__(self, outer):
            self.outer = outer

        def get_range(self, *, dataset, symbols, schema, stype_in, start, end):
            self.outer.calls += 1
            if self.outer.fail:
                raise self.outer.fail
            if schema != "ohlcv-1m":
                return []
            lo, hi = _parse(start), _parse(end)
            iid = self.outer.iids.get(symbols[0], INSTRUMENT)
            return [FakeRec(t, iid) for t in self.outer.traded if lo <= t < hi]

    @property
    def timeseries(self):
        return FakeClient._TS(self)


def _iso(ts: int) -> str:
    import datetime as dt

    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _parse(s: str) -> int:
    import datetime as dt

    return int(dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=dt.timezone.utc).timestamp())


class Cfg:
    """Only the attributes the loader and refresher actually read."""

    def __init__(self, replay_hours=24, refresh="auto", max_cost=2.0) -> None:
        self.replay_hours = replay_hours
        self.hist_refresh = refresh
        self.hist_max_cost_usd = max_cost
        self.hist_m1_days, self.hist_h1_days, self.hist_d1_days = 105, 0, 0
        self.api_key = types.SimpleNamespace(reveal=lambda: "fake-key-never-real")


class LiveBuffer:
    """Mirrors CandleStore: a rolling window that evicts the oldest minute."""

    def __init__(self, max_bars: int) -> None:
        self.max_bars, self.bars = max_bars, {}

    def add(self, t: int) -> None:
        self.bars[t] = {"time": t}
        while len(self.bars) > self.max_bars:
            del self.bars[min(self.bars)]


def traded_minutes(start: int, hours: int) -> list[int]:
    """Minutes the market is open: every minute except the 21:00-22:00 UTC break."""
    out = []
    for i in range(hours * 60):
        t = start + i * MIN
        if (t % 86400) // 3600 == 21:      # the daily maintenance hour
            continue
        out.append(t)
    return out


# --------------------------------------------------------------------------- tests
def test_refresh_merges_and_never_clears():
    store = HistoryStore("GC", "GCZ6", INSTRUMENT)
    t0 = 1_793_000_000 // 60 * 60
    traded = traded_minutes(t0, 48)
    clock = [t0 + 24 * HOUR]
    loader = HistoryLoader(Cfg(), lambda s: None, client_factory=lambda: FakeClient(lambda: clock[0], traded))

    loader.load(store)
    first = len(store.bars["ohlcv-1m"])
    assert first > 0 and store.state == READY

    clock[0] = t0 + 48 * HOUR               # time moves on; refresh should ADD, not replace
    loader.refresh(store)
    assert len(store.bars["ohlcv-1m"]) > first, "refresh must extend coverage"
    assert store.state == READY


def test_failure_keeps_a_healthy_store(caplog):
    """Requirement 7: fail closed WITHOUT clearing good history."""
    store = HistoryStore("GC", "GCZ6", INSTRUMENT)
    t0 = 1_793_000_000 // 60 * 60
    traded = traded_minutes(t0, 24)
    clock = [t0 + 24 * HOUR]
    good = FakeClient(lambda: clock[0], traded)
    loader = HistoryLoader(Cfg(), lambda s: None, client_factory=lambda: good)
    loader.load(store)
    assert store.state == READY
    bars_before = dict(store.bars["ohlcv-1m"])

    broken = FakeClient(lambda: clock[0], traded, fail=RuntimeError("upstream 503"))
    loader.client_factory = lambda: broken
    loader.refresh(store)

    assert store.state == READY, "a transient failure must not downgrade a healthy store"
    assert store.bars["ohlcv-1m"] == bars_before, "no bar may be lost on failure"


def test_cost_block_preserves_history():
    store = HistoryStore("GC", "GCZ6", INSTRUMENT)
    t0 = 1_793_000_000 // 60 * 60
    traded = traded_minutes(t0, 24)
    clock = [t0 + 24 * HOUR]
    loader = HistoryLoader(Cfg(), lambda s: None,
                           client_factory=lambda: FakeClient(lambda: clock[0], traded))
    loader.load(store)
    bars_before = dict(store.bars["ohlcv-1m"])

    loader.client_factory = lambda: FakeClient(lambda: clock[0], traded, cost=999.0)
    loader.refresh(store)
    assert store.bars["ohlcv-1m"] == bars_before, "a cost block must not discard held bars"
    assert store.state == READY, "and must not downgrade the reported state"


def test_foreign_contract_records_are_refused():
    store = HistoryStore("GC", "GCZ6", INSTRUMENT)
    assert store.add("ohlcv-1m", FakeRec(1_793_000_000, instrument_id=INSTRUMENT)) is True
    assert store.add("ohlcv-1m", FakeRec(1_793_000_060, instrument_id=9999)) is False
    assert len(store.bars["ohlcv-1m"]) == 1


def test_refresh_interval_is_inside_the_live_overlap():
    """The whole point: refresh must land well before the buffer stops overlapping."""
    r = HistoryRefresher(Cfg(replay_hours=24, refresh="auto"), None, lambda: {})
    overlap_s = (24 * 60 + 120) * 60          # 1560 bars of traded minutes
    assert r.interval_s("GC") < overlap_s / 2, "interval must leave room for failed attempts"
    assert r.interval_s("GC") >= 900, "and must not hammer the API"


def test_explicit_interval_overrides_the_derived_one():
    assert HistoryRefresher(Cfg(refresh="1800"), None, lambda: {}).interval_s("GC") == 1800.0
    # a too-small number is floored, so a typo cannot hammer the API
    assert HistoryRefresher(Cfg(refresh="5"), None, lambda: {}).interval_s("GC") == 900.0


AUTO = 1560 * 60 / 4.0          # a quarter of the live overlap at replay_hours=24


@pytest.mark.parametrize("value,expected", [
    # The global forms, which must keep behaving exactly as before.
    ("off",               {}),
    ("",                  {}),
    ("0",                 {}),
    ("auto",              {"GC": AUTO, "SI": AUTO}),
    ("1800",              {"GC": 1800.0, "SI": 1800.0}),
    # The per-root forms.
    ("GC",                {"GC": AUTO}),
    ("gc",                {"GC": AUTO}),
    ("  GC  ",            {"GC": AUTO}),
    ("GC:auto",           {"GC": AUTO}),
    ("GC:21600",          {"GC": 21600.0}),
    ("SI",                {"SI": AUTO}),
    ("GC,SI",             {"GC": AUTO, "SI": AUTO}),
    ("GC:auto,SI:28800",  {"GC": AUTO, "SI": 28800.0}),
    ("GC:auto,SI:off",    {"GC": AUTO}),
    ("GC:auto,SI:0",      {"GC": AUTO}),
    # A typo must disable, never enable something unintended.
    ("XAUUSD:auto",       {}),
    ("GC:auto,XAU:auto",  {"GC": AUTO}),
    ("GC:nonsense",       {}),
    ("nonsense",          {}),
])
def test_the_per_root_grammar(value, expected):
    """Items 1-4: independent GC / SI control, default off, global behaviour kept.

    A root present in the plan is enabled; a root absent from it is off. Both the
    global and the per-root form therefore fail in the safe direction.
    """
    r = HistoryRefresher(Cfg(refresh=value), None, lambda: {})
    assert r.plan() == expected
    for root in ("GC", "SI"):
        assert r.enabled(root) is (root in expected)
        assert r.interval_s(root) == expected.get(root)
    assert r.any_enabled() is bool(expected)


def test_gc_only_leaves_si_completely_alone():
    """Item 6, at the decision level: SI must not even be asked about.

    Checked with a per-contract request counter, so "no SI refresh" means no SI
    request was issued - not that one was issued and then thrown away.
    """
    t0 = 1_793_000_000 // 60 * 60
    traded = traded_minutes(t0, 48)
    clock = [t0 + 24 * HOUR]
    calls = {"GCZ6": 0, "SIZ6": 0}

    class Counting(FakeClient):
        @property
        def timeseries(self):
            inner = FakeClient._TS(self)
            real = inner.get_range

            def get_range(**kw):
                calls[kw["symbols"][0]] += 1
                return real(**kw)

            inner.get_range = get_range
            return inner

    loader = HistoryLoader(Cfg(), lambda s: None,
                           client_factory=lambda: Counting(lambda: clock[0], traded, iids=IIDS))
    stores = {"GC": HistoryStore("GC", "GCZ6", INSTRUMENT),
              "SI": HistoryStore("SI", "SIZ6", INSTRUMENT + 1)}
    for st in stores.values():
        loader.load(st)                      # the first load, as hub.on_contract does
    assert calls == {"GCZ6": 1, "SIZ6": 1}

    r = HistoryRefresher(Cfg(refresh="GC:auto"), loader, lambda: stores, now=lambda: clock[0])
    clock[0] = t0 + 48 * HOUR

    assert r.run_once("GC") == "REFRESHED"
    assert r.run_once("SI") == "DISABLED"
    assert calls == {"GCZ6": 2, "SIZ6": 1}, "enabling GC must not issue a single SI request"
    assert "SI" not in r._next_due, "a disabled root must not even get a timer"
    assert "SI" not in r._failures


def test_si_can_be_enabled_separately_afterwards():
    """Item 7: GC first, then SI, with nothing about GC disturbed by the change."""
    t0 = 1_793_000_000 // 60 * 60
    traded = traded_minutes(t0, 72)
    clock = [t0 + 24 * HOUR]
    loader = HistoryLoader(Cfg(), lambda s: None,
                           client_factory=lambda: FakeClient(lambda: clock[0], traded, iids=IIDS))
    stores = {"GC": HistoryStore("GC", "GCZ6", INSTRUMENT),
              "SI": HistoryStore("SI", "SIZ6", INSTRUMENT + 1)}
    for st in stores.values():
        loader.load(st)

    cfg = Cfg(refresh="GC:auto")              # stage one: GC only
    r = HistoryRefresher(cfg, loader, lambda: stores, now=lambda: clock[0])
    clock[0] = t0 + 48 * HOUR
    assert r.run_once("GC") == "REFRESHED"
    assert r.run_once("SI") == "DISABLED"
    si_bars = len(stores["SI"].bars["ohlcv-1m"])
    gc_due = r._next_due["GC"]

    cfg.hist_refresh = "GC:auto,SI:auto"      # stage two: add SI, as changing the variable does
    clock[0] = t0 + 72 * HOUR
    assert r.enabled("SI") is True
    assert r.run_once("SI") == "REFRESHED"

    assert len(stores["SI"].bars["ohlcv-1m"]) > si_bars, "SI must now extend its coverage"
    assert r._next_due["GC"] == gc_due, "adding SI must not reschedule GC"
    assert stores["GC"].state == READY and stores["SI"].state == READY


@pytest.mark.parametrize("value", ["", "0", "off", "false", "no", "disabled", "   ", "nonsense"])
def test_disabled_means_no_request_is_ever_made(value):
    """Requirement 2: disabled must mean NO automatic Historical API request.

    Not "a request that fails", not "a request that is discarded" - none issued at
    all. The fake client counts calls, so this is checked rather than assumed. An
    unparseable value falls back to disabled: the safe direction for a typo.
    """
    t0 = 1_793_000_000 // 60 * 60
    client = FakeClient(lambda: t0, T_TRADED := traded_minutes(t0, 24))
    store = HistoryStore("GC", "GCZ6", INSTRUMENT)
    loader = HistoryLoader(Cfg(refresh=value), lambda s: None, client_factory=lambda: client)
    r = HistoryRefresher(Cfg(refresh=value), loader, lambda: {"GC": store}, now=lambda: t0 + 10 ** 6)

    assert r.enabled("GC") is False
    assert r.any_enabled() is False
    assert r.interval_s("GC") is None
    assert r.due("GC") is False
    assert r.run_once("GC") == "DISABLED"
    assert client.calls == 0, "a disabled refresher must issue no Historical API call"
    assert store.bars["ohlcv-1m"] == {}, "and must not touch the store"


def test_production_default_is_disabled():
    """Requirement 3: absent configuration must mean off."""
    from tluxe_databento_bridge.config import BridgeConfig
    import dataclasses

    field = {f.name: f for f in dataclasses.fields(BridgeConfig)}.get("hist_refresh")
    assert field is not None, "hist_refresh must exist on BridgeConfig"
    assert str(field.default).strip().lower() in ("off", "0", ""),         f"the production default must be off, not {field.default!r}"


def test_backoff_grows_and_is_capped():
    r = HistoryRefresher(Cfg(), None, lambda: {})
    seq = [r.backoff_s(i) for i in range(1, 12)]
    assert seq[0] == 60.0
    assert seq == sorted(seq), "must be non-decreasing"
    assert max(seq) <= 3600.0, "must be capped"


def test_concurrent_refresh_is_refused():
    store = HistoryStore("GC", "GCZ6", INSTRUMENT)
    r = HistoryRefresher(Cfg(), None, lambda: {"GC": store})
    r._inflight["GC"] = True
    assert r.run_once("GC") == "ALREADY_RUNNING"


def test_roots_are_independent():
    t0 = 1_793_000_000 // 60 * 60
    traded = traded_minutes(t0, 24)
    clock = [t0 + 24 * HOUR]
    stores = {"GC": HistoryStore("GC", "GCZ6", INSTRUMENT),
              "SI": HistoryStore("SI", "SIZ6", INSTRUMENT + 1)}

    def factory():
        return FakeClient(lambda: clock[0], traded)

    loader = HistoryLoader(Cfg(), lambda s: None, client_factory=factory)
    for st in stores.values():
        loader.load(st)                     # the first load, as hub.on_contract does at startup
    r = HistoryRefresher(Cfg(), loader, lambda: stores, now=lambda: clock[0])
    assert r.run_once("GC") == "REFRESHED"

    # GC now fails; SI must be untouched by it
    loader.client_factory = lambda: FakeClient(lambda: clock[0], traded, fail=RuntimeError("boom"))
    clock[0] += 10 * HOUR
    r.run_once("GC")
    assert r._failures.get("SI", 0) == 0, "a GC failure must not count against SI"
    assert r._inflight.get("SI") in (None, False)


def _merged_minutes(store: HistoryStore, live: LiveBuffer) -> set[int]:
    """Exactly what hub.candles() serves: historical union live."""
    return set(store.bars["ohlcv-1m"]) | set(live.bars)


@pytest.mark.parametrize("refresh_enabled", [False, True])
def test_72h_healthy_operation_opens_no_gap(refresh_enabled):
    """Requirement 8, and the whole reason this change exists.

    Run 72 hours of entirely healthy operation - no disconnect, no outage, no
    upstream fault - and ask whether a hole appears between the historical window
    and the live buffer.

    With the refresh disabled this MUST fail, which is what proves the test is
    measuring the real fault rather than agreeing with itself.
    """
    t0 = 1_793_000_000 // 60 * 60
    traded = traded_minutes(t0, 96)
    traded_set = set(traded)
    clock = [t0]

    cfg = Cfg(replay_hours=24)
    store = HistoryStore("GC", "GCZ6", INSTRUMENT)
    live = LiveBuffer(max_bars=max(60, cfg.replay_hours * 60 + 120))
    loader = HistoryLoader(cfg, lambda s: None, client_factory=lambda: FakeClient(lambda: clock[0], traded))
    refresher = HistoryRefresher(cfg, loader, lambda: {"GC": store}, now=lambda: clock[0])

    loader.load(store)                      # the one load the bridge does today

    worst_gap_minutes = 0
    for step in range(72 * 60):             # one simulated minute at a time
        clock[0] = t0 + step * MIN
        if clock[0] in traded_set:
            live.add(clock[0])
        if refresh_enabled and refresher.due("GC"):
            refresher.run_once("GC")

        if step % 60 == 0 and step > 0:     # check hourly
            merged = _merged_minutes(store, live)
            expected = {t for t in traded if t0 <= t <= clock[0]}
            missing = expected - merged
            worst_gap_minutes = max(worst_gap_minutes, len(missing))

    if refresh_enabled:
        assert worst_gap_minutes == 0, (
            f"healthy operation opened a {worst_gap_minutes}-minute hole even with refresh on")
    else:
        assert worst_gap_minutes > 0, (
            "the no-refresh case must reproduce the fault, or this test proves nothing")
