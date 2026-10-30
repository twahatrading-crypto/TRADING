"""Phase 2A: the refresh wired into the real Manager and the real Hub.

The Phase 1 tests exercised `HistoryRefresher` on its own. These drive the actual
`Manager` - its own `HistoryRefresher`, its own thread, the real `Hub`, the real
`HistoryStore` and the real `CandleStore` - with a fake Databento Historical client
and a fake Live client. No network call is made, no credential is read, and no
fixture is ever served as market data.

The questions each group answers:

  startup   - does an OFF bridge issue any automatic Historical request? (none)
  enabled   - do GC and SI refresh independently, one request each?
  shutdown  - does the refresh thread end when the manager stops?
  roll      - after a contract roll, is the NEW store refreshed and the old one left alone?
  failure   - does a failed refresh ever downgrade or clear a healthy history? (no)
  cost      - does a cost block clear anything? (no)
  overlap   - can two attempts run at once? (no)
  robustness- can a raising refresh take the bridge's loop down? (no)
  merge     - is `historical union live, live wins` still what is served?
  72 hours  - does healthy operation still open a gap through the real wiring?
"""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_history_refresh import FakeRec, _iso, _parse, traded_minutes  # noqa: E402

from tluxe_databento_bridge.candles import CandleStore  # noqa: E402
from tluxe_databento_bridge.config import BridgeConfig, Secret  # noqa: E402
from tluxe_databento_bridge.history import COST_BLOCKED, READY, HistoryStore  # noqa: E402
from tluxe_databento_bridge.hub import Hub  # noqa: E402
from tluxe_databento_bridge.manager import Manager  # noqa: E402

MIN = 60
HOUR = 3600
T0 = 1_793_000_000 // 60 * 60          # a minute boundary, 2026-10-26-ish
M1 = "ohlcv-1m"


# --------------------------------------------------------------------------- fakes
class HistClient:
    """A Databento Historical stand-in that records WHICH contract each call asked for.

    Per-symbol accounting is the point: "GC and SI refresh independently" is only
    shown by seeing one request per contract, not by a total that could be either.
    """

    def __init__(self, clock, traded, cost=0.0) -> None:
        self.clock, self.traded, self.cost = clock, traded, cost
        self.calls = 0
        self.by_symbol: dict[str, int] = {}
        self.fail: BaseException | None = None            # fail every call
        self.fail_symbol: dict[str, BaseException] = {}   # fail only this contract
        self.gate: threading.Event | None = None          # block inside a call
        self.entered = threading.Event()

    # -- metadata
    class _Meta:
        def __init__(self, outer) -> None:
            self.outer = outer

        def get_dataset_range(self, dataset):
            return {"end": _iso(self.outer.clock())}

        def get_cost(self, **kw):
            return self.outer.cost

    @property
    def metadata(self):
        return HistClient._Meta(self)

    # -- timeseries
    class _TS:
        def __init__(self, outer) -> None:
            self.outer = outer

        def get_range(self, *, dataset, symbols, schema, stype_in, start, end):
            o = self.outer
            sym = symbols[0]
            o.calls += 1
            o.by_symbol[sym] = o.by_symbol.get(sym, 0) + 1
            o.entered.set()
            if o.gate is not None:
                o.gate.wait(5)
            if o.fail is not None:
                raise o.fail
            if sym in o.fail_symbol:
                raise o.fail_symbol[sym]
            if schema != M1:
                return []
            lo, hi = _parse(start), _parse(end)
            return [FakeRec(t, INSTRUMENTS[sym]) for t in o.traded if lo <= t < hi]

    @property
    def timeseries(self):
        return HistClient._TS(self)


class FakeLive:
    """Enough of databento.Live for SessionRunner to open and close a session."""

    def __init__(self) -> None:
        self.closed = threading.Event()

    def add_callback(self, record_cb, error_cb=None) -> None:
        pass

    def subscribe(self, **kw) -> None:
        pass

    def start(self) -> None:
        pass

    def block_for_close(self) -> None:
        self.closed.wait(30)

    def terminate(self) -> None:
        self.closed.set()


INSTRUMENTS = {"GCZ6": 4242, "GCG7": 4343, "SIZ6": 5252}


# --------------------------------------------------------------------------- wiring
LEAD_IN_H = 48      # traded minutes BEFORE T0, so the first load has something to return


def wire(refresh="off", hours=80, cost=0.0, clock=None):
    """A real Manager over a real Hub, with both Databento clients faked.

    The fake Historical client's coverage starts `LEAD_IN_H` before T0 and runs
    `hours` past it, so an initial load at T0 returns real (fixture) bars and a
    later refresh at a later clock returns more - which is what makes the gap
    arithmetic in the 72 h test meaningful rather than vacuous.
    """
    cfg = BridgeConfig(
        api_key=Secret("fake-key-never-real"), token=Secret("fake-token-never-real"),
        publish_ms=50,                  # the refresh loop ticks at publish_ms * 10 = 0.5 s
        replay_hours=24,                # -> live buffer 1560 bars, as in production
        hist_m1_days=105, hist_h1_days=0, hist_d1_days=0,
        hist_max_cost_usd=2.0,
        hist_refresh=refresh,
    )
    hub = Hub(cfg)
    hist = HistClient(clock or (lambda: T0),
                      traded_minutes(T0 - LEAD_IN_H * HOUR, LEAD_IN_H + hours), cost=cost)
    man = Manager(cfg, factory=lambda key, hb: FakeLive(), hub=hub,
                  history_client_factory=lambda: hist)
    return man, hub, hist


def resolve(man, hub, root: str, contract: str, expect: str = READY):
    """Exactly what `Hub._mapping` does when a root resolves to a contract.

    Driving it directly keeps the test about the refresh wiring rather than about
    synthesising a Databento SymbolMappingMsg.
    """
    iid = INSTRUMENTS[contract]
    st = hub.roots[root]
    st.contract, st.instrument_id = contract, iid
    st.candles = CandleStore(iid, max_bars=max(60, hub.cfg.replay_hours * 60 + 120))
    st.history = HistoryStore(root, contract, iid)
    hub.on_contract(st.history)        # -> manager.history.start, in a thread
    assert wait_until(lambda: st.history.state == expect, 5), st.history.state
    return st


def wait_until(pred, timeout=3.0, step=0.01) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(step)
    return pred()


def count_asks(man):
    """Wrap the refresher's run_once so a test can wait for real loop activity.

    A negative test ("SI must never be refreshed") otherwise has to sleep a guessed
    number of ticks and hope. With this it waits for proof that the loop asked about
    SI n times and that every answer was DISABLED - deterministic, and a stronger
    claim than a blind sleep.
    """
    asks: list[tuple[str, str]] = []
    inner = man.refresher.run_once

    def run_once(root):
        out = inner(root)
        asks.append((root, out))
        return out

    man.refresher.run_once = run_once
    return asks


def asked(asks, root, n=1):
    return sum(1 for r, _ in asks if r == root) >= n


def bars(st) -> dict:
    return st.history.bars[M1]


# --------------------------------------------------------------------------- startup
def test_startup_with_refresh_off_issues_no_historical_request():
    """Requirements 2 and 3: the production default must make no automatic request.

    Not "a request that is discarded" - none issued. The manager's refresh thread
    is started unconditionally (so enabling it later needs only the variable), so
    this is the test that proves the thread is genuinely inert while off.
    """
    man, hub, hist = wire(refresh="off")
    gc = resolve(man, hub, "GC", "GCZ6")
    si = resolve(man, hub, "SI", "SIZ6")
    baseline = hist.calls                       # the two initial loads
    assert baseline == 2
    assert man.refresher.any_enabled() is False

    # With every root off the loop short-circuits on any_enabled() and does not even
    # enumerate the roots, so THAT is the signal that it ran - counting it is both
    # deterministic and a tighter statement than counting declined roots.
    asks = count_asks(man)
    ticks = [0]
    inner = man.refresher.any_enabled

    def any_enabled():
        ticks[0] += 1
        return inner()

    man.refresher.any_enabled = any_enabled

    man.start()
    try:
        assert wait_until(lambda: ticks[0] >= 3, 6), ticks   # proof the loop ran, three times over
    finally:
        man.stop()

    assert asks == [], "with every root off the loop must not even reach a root"
    assert hist.calls == baseline, "a disabled refresher must issue no Historical API call"
    assert len(bars(gc)) and len(bars(si)), "and must leave both histories alone"


def test_startup_with_refresh_auto_refreshes_each_root_independently():
    """Requirement 4: GC and SI refresh separately, one request per contract."""
    man, hub, hist = wire(refresh="auto")
    resolve(man, hub, "GC", "GCZ6")
    resolve(man, hub, "SI", "SIZ6")
    assert hist.by_symbol == {"GCZ6": 1, "SIZ6": 1}       # the initial loads

    man.start()
    try:
        assert wait_until(lambda: hist.by_symbol.get("GCZ6", 0) >= 2
                          and hist.by_symbol.get("SIZ6", 0) >= 2, 5), hist.by_symbol
    finally:
        man.stop()

    # One refresh each, then both are scheduled 6.5 h out - not a hot loop.
    assert hist.by_symbol["GCZ6"] == 2, hist.by_symbol
    assert hist.by_symbol["SIZ6"] == 2, hist.by_symbol
    assert man.refresher.interval_s("GC") == pytest.approx(1560 * 60 / 4)


def test_shutdown_ends_the_refresh_thread():
    man, _hub, _hist = wire(refresh="auto")
    man.start()
    assert man._refresh.is_alive()
    man.stop()
    man._refresh.join(3)
    assert not man._refresh.is_alive(), "the refresh thread must not outlive stop()"


# --------------------------------------------------------------------------- per-root control
def test_gc_only_through_the_manager_never_refreshes_si():
    """Item 6, through the real wiring: GC:auto must leave SI at its initial load.

    The manager's loop steps every root in the hub, so this is where a per-root
    filter could silently fail to apply - the refresher is asked about each root,
    and SI must answer DISABLED.
    """
    man, hub, hist = wire(refresh="GC:auto")
    gc = resolve(man, hub, "GC", "GCZ6")
    si = resolve(man, hub, "SI", "SIZ6")
    assert hist.by_symbol == {"GCZ6": 1, "SIZ6": 1}       # the two initial loads
    si_bars = len(bars(si))

    assert man.refresher.enabled("GC") is True
    assert man.refresher.enabled("SI") is False

    asks = count_asks(man)
    man.start()
    try:
        # Proof that the loop asked about SI three times and declined every time,
        # rather than a sleep long enough to hope it would have.
        assert wait_until(lambda: hist.by_symbol.get("GCZ6", 0) >= 2
                          and asked(asks, "SI", 3), 6), (hist.by_symbol, asks)
    finally:
        man.stop()

    assert [out for r, out in asks if r == "SI"] == ["DISABLED"] * len(
        [1 for r, _ in asks if r == "SI"]), asks
    assert hist.by_symbol["SIZ6"] == 1, "GC:auto must not issue a single SI request"
    assert len(bars(si)) == si_bars, "and must not touch SI's history"
    assert len(bars(gc)) > 0 and gc.history.state == READY
    assert "SI" not in man.refresher._next_due, "a disabled root must not even get a timer"


def test_si_enabled_in_a_later_change_refreshes_both():
    """Item 7, through the real wiring.

    Enabling SI in production means editing the Railway variable, which restarts
    the service - so the faithful model is a fresh manager reading the new value,
    not a config mutated in place.
    """
    man, hub, hist = wire(refresh="GC:auto,SI:auto")
    resolve(man, hub, "GC", "GCZ6")
    resolve(man, hub, "SI", "SIZ6")

    man.start()
    try:
        assert wait_until(lambda: hist.by_symbol.get("GCZ6", 0) >= 2
                          and hist.by_symbol.get("SIZ6", 0) >= 2, 5), hist.by_symbol
    finally:
        man.stop()

    assert man.refresher.interval_s("GC") == pytest.approx(1560 * 60 / 4)
    assert man.refresher.interval_s("SI") == pytest.approx(1560 * 60 / 4)
    assert hist.by_symbol == {"GCZ6": 2, "SIZ6": 2}, "one refresh each, then both scheduled out"


def test_independent_intervals_are_honoured_per_root():
    man, hub, _hist = wire(refresh="GC:auto,SI:28800")
    assert man.refresher.interval_s("GC") == pytest.approx(1560 * 60 / 4)
    assert man.refresher.interval_s("SI") == 28800.0
    assert man.refresher.any_enabled() is True


def test_a_gc_failure_while_si_is_off_touches_nothing_of_si():
    """Item 8 failure recovery, with the per-root switch in play."""
    man, hub, hist = wire(refresh="GC:auto")
    gc = resolve(man, hub, "GC", "GCZ6")
    si = resolve(man, hub, "SI", "SIZ6")
    si_before = dict(bars(si))

    hist.fail = RuntimeError("Databento Historical API: 503 service unavailable")
    man.refresher.now = lambda: T0 + 10 ** 7
    assert man.refresher.run_once("GC") == "FAILED"
    assert man.refresher.run_once("SI") == "DISABLED"

    assert gc.history.state == READY, "GC keeps its healthy history"
    assert man.refresher._failures["GC"] == 1
    assert "SI" not in man.refresher._failures, "SI has no failure state to inherit"
    assert bars(si) == si_before
    assert si.history.state == READY


def test_a_cost_block_while_gc_only_is_enabled_downloads_nothing():
    """Item 8 cost limits, with the per-root switch in play."""
    man, hub, hist = wire(refresh="GC:auto", cost=99.0)   # over hist_max_cost_usd = 2.0
    gc = resolve(man, hub, "GC", "GCZ6", expect=COST_BLOCKED)
    assert not bars(gc), "a cost-blocked store holds no bars at all"
    assert hist.by_symbol.get("GCZ6", 0) == 0, "a cost block must not download anything"

    man.refresher.now = lambda: T0 + 10 ** 7
    assert man.refresher.run_once("GC") == "FAILED"
    assert hist.by_symbol.get("GCZ6", 0) == 0, "and a refresh must not either"
    assert gc.history.state == COST_BLOCKED, "the blocked state is reported, not masked"


def test_gc_only_contract_roll_refreshes_the_new_contract_and_still_not_si():
    """Item 8 rollover, with the per-root switch in play."""
    man, hub, hist = wire(refresh="GC:auto")
    gc = resolve(man, hub, "GC", "GCZ6")
    resolve(man, hub, "SI", "SIZ6")
    old_store = gc.history

    resolve(man, hub, "GC", "GCG7")                       # the roll
    hist.by_symbol.clear()
    man.refresher.now = lambda: T0 + 10 ** 7

    assert man.refresher.run_once("GC") == "REFRESHED"
    assert man.refresher.run_once("SI") == "DISABLED"
    assert hist.by_symbol == {"GCG7": 1}, "only the new GC contract may be refreshed"
    assert old_store.contract == "GCZ6"


def test_shutdown_ends_the_thread_with_only_one_root_enabled():
    """Item 8 shutdown, with the per-root switch in play."""
    man, hub, _hist = wire(refresh="GC:auto")
    resolve(man, hub, "GC", "GCZ6")
    man.start()
    assert man._refresh.is_alive()
    man.stop()
    man._refresh.join(3)
    assert not man._refresh.is_alive()


# --------------------------------------------------------------------------- roll
def test_contract_roll_refreshes_the_new_store_and_leaves_the_old_one():
    """The refresher reads stores through the hub, so a roll is picked up.

    A refresher holding a direct reference would keep reloading the expired
    contract - and write its bars into a store nothing serves.
    """
    man, hub, hist = wire(refresh="auto")
    gc = resolve(man, hub, "GC", "GCZ6")
    old_store = gc.history
    old_count = len(bars(gc))

    resolve(man, hub, "GC", "GCG7")             # the roll: a new HistoryStore
    assert gc.history is not old_store
    hist.by_symbol.clear()

    man.refresher.now = lambda: T0 + 10 ** 7    # make it due
    assert man.refresher.run_once("GC") == "REFRESHED"

    assert hist.by_symbol == {"GCG7": 1}, "only the current contract may be refreshed"
    assert len(old_store.bars[M1]) == old_count, "the expired store must not be touched"


# --------------------------------------------------------------------------- failure
def test_api_failure_during_refresh_keeps_the_healthy_history():
    """Requirement 6: a failed refresh must not clear or downgrade good history."""
    man, hub, hist = wire(refresh="auto")
    gc = resolve(man, hub, "GC", "GCZ6")
    before = dict(bars(gc))

    hist.fail = RuntimeError("Databento Historical API: 503 service unavailable")
    man.refresher.now = lambda: T0 + 10 ** 7
    assert man.refresher.run_once("GC") == "FAILED"

    assert gc.history.state == READY, "a transient failure must not take good history off the air"
    assert gc.history.message is None
    assert bars(gc) == before, "and must not change a single bar"


def test_cost_block_during_refresh_does_not_clear_history():
    """A COST_BLOCKED store holds no bars - so a blocked REFRESH must not become one."""
    man, hub, hist = wire(refresh="auto")
    gc = resolve(man, hub, "GC", "GCZ6")
    before = dict(bars(gc))

    hist.cost = 99.0                            # over hist_max_cost_usd = 2.0
    man.refresher.now = lambda: T0 + 10 ** 7
    assert man.refresher.run_once("GC") == "FAILED"

    assert gc.history.state == READY
    assert bars(gc) == before
    assert hist.by_symbol["GCZ6"] == 1, "a cost block must not download anything"


def test_a_gc_failure_leaves_si_untouched():
    """Requirement 4 again, on the failure path: no shared budget, flag or outcome."""
    man, hub, hist = wire(refresh="auto")
    gc = resolve(man, hub, "GC", "GCZ6")
    si = resolve(man, hub, "SI", "SIZ6")
    hist.fail_symbol["GCZ6"] = RuntimeError("Databento Historical API: 503")

    man.refresher.now = lambda: T0 + 10 ** 7
    assert man.refresher.run_once("GC") == "FAILED"
    assert man.refresher.run_once("SI") == "REFRESHED"

    assert gc.history.state == READY and si.history.state == READY
    assert man.refresher._failures["GC"] == 1
    assert man.refresher._failures["SI"] == 0, "SI must not inherit GC's failure count"


def test_repeated_failure_backs_off_and_never_tight_loops():
    man, hub, hist = wire(refresh="auto")
    resolve(man, hub, "GC", "GCZ6")
    hist.fail = RuntimeError("down")
    clock = [T0 + 10 ** 7]
    man.refresher.now = lambda: clock[0]

    waits = []
    for _ in range(8):
        assert man.refresher.run_once("GC") == "FAILED"
        waits.append(man.refresher._next_due["GC"] - clock[0])
        clock[0] = man.refresher._next_due["GC"]

    assert waits[0] == 60.0
    assert waits == sorted(waits), "backoff must not shrink while it keeps failing"
    assert max(waits) == 3600.0, "and must cap at an hour"
    assert min(waits) >= 60.0, "never a tight retry loop"


# --------------------------------------------------------------------------- overlap
def test_two_overlapping_refresh_attempts_run_only_once():
    """Requirement 7: a refresh already in flight is never started a second time."""
    man, hub, hist = wire(refresh="auto")
    resolve(man, hub, "GC", "GCZ6")
    man.refresher.now = lambda: T0 + 10 ** 7

    hist.gate = threading.Event()
    hist.entered.clear()
    hist.by_symbol.clear()
    out: list[str] = []
    first = threading.Thread(target=lambda: out.append(man.refresher.run_once("GC")))
    first.start()
    assert hist.entered.wait(5), "the first attempt never reached the API"

    second = man.refresher.run_once("GC")       # while the first is still inside
    hist.gate.set()
    first.join(5)

    assert second == "ALREADY_RUNNING", second
    assert out == ["REFRESHED"], out
    assert hist.by_symbol == {"GCZ6": 1}, "the overlapping attempt must issue no request"


def test_a_raising_refresh_cannot_take_the_bridge_loop_down():
    """The loop catches per-root exceptions: one bad refresh must not stop the rest."""
    man, hub, _hist = wire(refresh="auto")
    resolve(man, hub, "GC", "GCZ6")
    calls = []

    def boom(root):
        calls.append(root)
        raise RuntimeError("unexpected")

    man.refresher.run_once = boom
    man.start()
    try:
        assert wait_until(lambda: len(calls) >= 3, 5), calls
    finally:
        man.stop()
    assert len(calls) >= 3, "the loop must keep ticking after an exception"


# --------------------------------------------------------------------------- merge
def test_reconnect_neither_clears_history_nor_triggers_a_request():
    """A live reconnect is a tape concern; history must be untouched by it."""
    man, hub, hist = wire(refresh="off")
    gc = resolve(man, hub, "GC", "GCZ6")
    before, baseline = dict(bars(gc)), hist.calls

    hub.request_resync("tape", "simulated reconnect")
    hub.take_resync("tape")

    assert bars(gc) == before
    assert gc.history.state == READY
    assert hist.calls == baseline


def test_live_still_wins_on_a_shared_minute_after_a_refresh():
    """Requirement 5: the historical/live merge behaviour is unchanged.

    A refresh rewrites official historical bars over minutes the live tape has
    already observed. `hub.candles()` must still serve the LIVE bar for those.
    """
    man, hub, hist = wire(refresh="auto")
    gc = resolve(man, hub, "GC", "GCZ6")
    shared = max(bars(gc))                       # a minute history already holds

    live = FakeRec(shared, INSTRUMENTS["GCZ6"])
    live.close = 1_234_000_000_000               # unmistakably not the historical close
    gc.candles.on_ohlcv(live)

    man.refresher.now = lambda: T0 + 10 ** 7
    assert man.refresher.run_once("GC") == "REFRESHED"

    served = {b["time"]: b for b in hub.candles("GC", "M1", 5000)["bars"]}
    assert served[shared]["close"] == pytest.approx(1234.0), "the live bar must win"
    assert len(served) >= len(bars(gc)), "and the union must still be served"


# --------------------------------------------------------------------------- concurrency
def test_writing_into_a_served_dict_is_what_must_not_happen():
    """The mechanism, deterministically, with no timing involved.

    `hub.candles()` iterates `store.bars['ohlcv-1m']`. Inserting a minute into that
    same dict mid-iteration raises - so a reload that writes into the SERVED store
    can fail a consumer's request outright. This is why `refresh()` loads into a
    detached store and rebinds the finished dict instead.
    """
    man, hub, _hist = wire(refresh="auto")
    gc = resolve(man, hub, "GC", "GCZ6")
    served = gc.history.bars[M1]

    walk = iter(served.items())
    next(walk)
    served[max(served) + 60] = {"time": max(served) + 60}      # a new minute arrives
    with pytest.raises(RuntimeError, match="changed size during iteration"):
        next(walk)


def test_a_refresh_never_breaks_a_concurrent_candles_request():
    """The same situation through the real code, with a production-sized history.

    100k historical bars, a refresh that brings 48 h of genuinely new minutes, and
    a reader calling `hub.candles()` throughout. Measured on 2026-10-29: the old
    in-place reload raised `RuntimeError: dictionary changed size during iteration`
    in the reader; the detached refresh does not.
    """
    clock = [T0 + 1700 * HOUR]
    man, hub, _hist = wire(refresh="auto", hours=1900, clock=lambda: clock[0])
    gc = resolve(man, hub, "GC", "GCZ6")
    assert len(bars(gc)) > 50_000, "the test needs a production-sized history to be meaningful"

    errors: list[str] = []
    reads = [0]
    stop = threading.Event()

    def reader() -> None:
        while not stop.is_set():
            try:
                hub.candles("GC", "M1", 5000)
                reads[0] += 1
            except Exception as exc:               # noqa: BLE001 - the thing under test
                errors.append(repr(exc))

    th = threading.Thread(target=reader, daemon=True)
    th.start()
    clock[0] += 48 * HOUR                          # time moves on: new minutes, not rewrites
    before = len(bars(gc))
    man.refresher.now = lambda: clock[0]
    try:
        assert man.refresher.run_once("GC") == "REFRESHED"
    finally:
        stop.set()
        th.join(5)

    assert reads[0] > 0, "the reader never got a request in - the test proved nothing"
    assert errors == [], f"a refresh broke {len(errors)} consumer request(s): {errors[:2]}"
    assert len(bars(gc)) > before, "and the refresh must still have extended coverage"


def test_a_refresh_is_skipped_while_the_first_load_is_still_running():
    """A refresh during the initial load would download the same window twice."""
    man, hub, hist = wire(refresh="auto")
    st = hub.roots["GC"]
    st.contract, st.instrument_id = "GCZ6", INSTRUMENTS["GCZ6"]
    st.history = HistoryStore("GC", "GCZ6", INSTRUMENTS["GCZ6"])   # LOADING, not yet loaded
    man.refresher.now = lambda: T0 + 10 ** 7

    assert man.refresher.run_once("GC") == "LOADING"
    assert hist.calls == 0, "and must issue no request of its own"


# --------------------------------------------------------------------------- 72 hours
@pytest.mark.parametrize("refresh,expect_gap", [("off", True), ("auto", False)])
def test_72h_healthy_operation_through_the_wired_manager(refresh, expect_gap):
    """Requirement 8, re-verified after integration - and the fault reproduced.

    72 simulated hours of healthy operation: no outage, no disconnect, every
    traded minute delivered live. The real `CandleStore` evicts at the real
    production cap (1560 bars = 26 traded-hours), and the real `HistoryStore`
    holds whatever the loader put there.

    With the refresh OFF the hole opens anyway, out of nothing but uptime - which
    is the fault, and which proves this test can fail. With it on AUTO the two
    windows keep touching and the merged series has no missing traded minute.
    """
    clock = [T0]
    man, hub, _hist = wire(refresh=refresh, hours=80, clock=lambda: clock[0])
    gc = resolve(man, hub, "GC", "GCZ6")
    man.refresher.now = lambda: clock[0]

    traded = set(traded_minutes(T0, 80))
    for hour in range(72):                       # one simulated hour per step
        for t in sorted(t for t in traded if clock[0] <= t < clock[0] + HOUR):
            gc.candles.on_ohlcv(FakeRec(t, INSTRUMENTS["GCZ6"]))
        clock[0] += HOUR
        man.refresher.run_once("GC")             # what _refresh_loop calls, hourly

    merged = set(bars(gc)) | set(gc.candles.bars)
    assert gc.candles.max_bars == 1560, "the production cap must be what was simulated"
    assert len(gc.candles.bars) == 1560, "the live buffer must be full and evicting"

    expected = {t for t in traded if min(merged) <= t <= max(merged)}
    missing = sorted(expected - merged)

    if expect_gap:
        assert missing, "the fault must still reproduce with the refresh off"
        hole_h = (missing[-1] - missing[0]) / HOUR
        assert hole_h > 20, f"expected a large eviction hole, got {hole_h:.1f} h"
    else:
        assert not missing, (f"{len(missing)} traded minutes missing, "
                             f"{_iso(missing[0])} .. {_iso(missing[-1])}" if missing else "")
        assert gc.history.state == READY
