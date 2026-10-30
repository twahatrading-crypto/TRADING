"""Real Databento HISTORICAL OHLCV for the CURRENT contract of a root (GC / SI) + deterministic timeframe assembly.

Source: Databento Historical API (`timeseries.get_range`, GLBX.MDP3), schemas `ohlcv-1m`, `ohlcv-1h`, `ohlcv-1d`, requested
for the RAW symbol of the contract the live continuous subscription (`GC.v.0` / `SI.v.0`) currently resolves to - so
prices from different contracts are never mixed. A roll loads the new contract's own history.

Safety: the request cost is estimated with `metadata.get_cost` BEFORE any download; if it exceeds
TLUXE_DB_HIST_MAX_COST_USD the download is refused and reported (COST_BLOCKED). An authentication / entitlement
rejection is reported as NOT_ENTITLED / AUTH_ERROR - never replaced by anything else.

Timeframes (no future information, UTC-aligned buckets):
  M1            historical ohlcv-1m + live ohlcv-1m (same official bars; live wins on the same minute) + forming bar
  M5 / M15 / M30 aggregated from that M1 series
  H1            historical ohlcv-1h before the first full hour covered by M1, then aggregated from M1
  H4            aggregated from that H1 series (a leading partial 4h window is dropped)
  D1            historical ohlcv-1d before the first full day covered by M1, then aggregated from M1
A bar is `isClosed` only when its whole window lies before the end of the last CLOSED M1 bar.
"""
from __future__ import annotations

import datetime as dt
import logging
import threading
import time

from .book import px
from .config import DATASET, ROOTS

log = logging.getLogger("tluxe.databento.history")

SCHEMAS = ("ohlcv-1m", "ohlcv-1h", "ohlcv-1d")
TF_SECONDS = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600, "H4": 14400, "D1": 86400}
LOADING, READY, UNAVAILABLE, NOT_ENTITLED, COST_BLOCKED, AUTH_ERROR, DISABLED = (
    "LOADING", "READY", "UNAVAILABLE", "NOT_ENTITLED", "COST_BLOCKED", "AUTH_ERROR", "DISABLED")


def _bar(t: int, o: float, h: float, l: float, c: float, v: int, closed: bool = True) -> dict:
    return {"time": t, "open": o, "high": h, "low": l, "close": c, "volume": v, "isClosed": closed}


def aggregate(bars: list[dict], sec: int, closed_until: int | None, drop_partial_head: bool = False) -> list[dict]:
    """UTC-aligned aggregation of time-sorted bars into `sec` buckets. Deterministic; volume = sum of real volume."""
    out: list[dict] = []
    for b in bars:
        t = b["time"] - b["time"] % sec
        if out and out[-1]["time"] == t:
            o = out[-1]
            o["high"], o["low"], o["close"] = max(o["high"], b["high"]), min(o["low"], b["low"]), b["close"]
            o["volume"] += b["volume"]
        else:
            out.append({**b, "time": t})
    if drop_partial_head and out and bars and bars[0]["time"] != out[0]["time"]:
        out.pop(0)  # the first window does not start at the start of the available data -> incomplete, dropped
    for o in out:
        o["isClosed"] = closed_until is not None and o["time"] + sec <= closed_until
    return out


def _ceil(t: int, sec: int) -> int:
    return -(-t // sec) * sec


def assemble(tf: str, m1: list[dict], hist: dict[str, dict[int, dict]], closed_until: int | None, limit: int = 5000) -> list[dict]:
    """Timeframe `tf` from the combined M1 series (historical + live, time-sorted, forming bar last if any) and the
    native historical ohlcv-1h / ohlcv-1d bars. Native bars are used only for windows that end BEFORE the M1 coverage
    starts, so the two sources never overlap and no window mixes them."""
    if tf == "M1":
        return [dict(b) for b in m1[-limit:]]
    if tf in ("M5", "M15", "M30"):
        return aggregate(m1, TF_SECONDS[tf], closed_until)[-limit:]
    first_m1 = m1[0]["time"] if m1 else None

    def native_then_m1(schema: str, sec: int) -> list[dict]:
        boundary = _ceil(first_m1, sec) if first_m1 is not None else None
        native = [dict(b) for t, b in sorted(hist.get(schema, {}).items()) if boundary is None or t + sec <= boundary]
        derived = aggregate([b for b in m1 if boundary is None or b["time"] >= boundary], sec, closed_until) if m1 else []
        for b in native:
            b["isClosed"] = True  # historical, entirely before the live M1 coverage
        return native + derived

    if tf == "H1":
        return native_then_m1("ohlcv-1h", 3600)[-limit:]
    if tf == "H4":
        h1 = native_then_m1("ohlcv-1h", 3600)
        return aggregate(h1, 14400, closed_until, drop_partial_head=True)[-limit:]
    if tf == "D1":
        return native_then_m1("ohlcv-1d", 86400)[-limit:]
    raise ValueError(tf)


class HistoryStore:
    """Historical bars of ONE contract (instrument id) for one root."""

    def __init__(self, root: str, contract: str, instrument_id: int) -> None:
        self.root, self.contract, self.instrument_id = root, contract, instrument_id
        self.bars: dict[str, dict[int, dict]] = {s: {} for s in SCHEMAS}
        self.state = LOADING
        self.message: str | None = None
        self.estimated_cost_usd: float | None = None
        self.range: dict | None = None
        self.loaded_at_ms: int | None = None

    def add(self, schema: str, r) -> bool:
        if int(r.instrument_id) != self.instrument_id:
            return False  # another contract - never mixed
        t = int(r.ts_event) // 1_000_000_000
        self.bars[schema][t] = _bar(t, px(r.open), px(r.high), px(r.low), px(r.close), int(r.volume))
        return True

    def view(self) -> dict:
        return {"state": self.state, "contract": self.contract, "instrumentId": self.instrument_id, "message": self.message,
                "bars": {s: len(b) for s, b in self.bars.items()}, "estimatedCostUsd": self.estimated_cost_usd, "range": self.range,
                "loadedAtMs": self.loaded_at_ms, "source": "Databento Historical API (timeseries.get_range)"}


def _iso(d: dt.datetime) -> str:
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _parse_end(rng) -> dt.datetime:
    """Dataset range end from `metadata.get_dataset_range` (dict or object; ISO string with up to 9 fractional digits)."""
    import re

    end = (rng.get("end") or rng.get("end_date")) if isinstance(rng, dict) else getattr(rng, "end", None)
    if isinstance(end, dt.datetime):
        return end if end.tzinfo else end.replace(tzinfo=dt.timezone.utc)
    m = re.match(r"(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?", str(end))
    if not m:
        raise ValueError(f"unexpected dataset range end: {end!r}")
    return dt.datetime.fromisoformat(f"{m.group(1)}T{m.group(2) or '00:00:00'}").replace(tzinfo=dt.timezone.utc)


_SCHEMA_SEC = {"ohlcv-1m": 60, "ohlcv-1h": 3600, "ohlcv-1d": 86400}


def _floor(end: dt.datetime, schema: str) -> dt.datetime:
    sec = _SCHEMA_SEC[schema]
    ts = int(end.timestamp())
    return dt.datetime.fromtimestamp(ts - ts % sec, dt.timezone.utc)


class HistoryLoader:
    """Fetches history in a background thread whenever a root resolves to a (new) contract."""

    def __init__(self, cfg, on_loaded, client_factory=None, now=lambda: int(time.time() * 1000)) -> None:
        self.cfg = cfg
        self.on_loaded = on_loaded  # (HistoryStore) -> None, called with the finished store
        self.client_factory = client_factory or self._default_client
        self.now = now

    def _default_client(self):
        import databento as db

        return db.Historical(self.cfg.api_key.reveal())

    def start(self, store: HistoryStore) -> threading.Thread:
        th = threading.Thread(target=self.load, args=(store,), name=f"history-{store.root}", daemon=True)
        th.start()
        return th

    def load(self, store: HistoryStore) -> HistoryStore:
        from .entitlement import AUTH, ENTITLEMENT, classify

        days = {"ohlcv-1m": self.cfg.hist_m1_days, "ohlcv-1h": self.cfg.hist_h1_days, "ohlcv-1d": self.cfg.hist_d1_days}
        try:
            client = self.client_factory()
            end = _parse_end(client.metadata.get_dataset_range(dataset=DATASET))
            # Each schema is only available up to its last COMPLETE interval (Databento answers 422
            # data_schema_not_fully_available otherwise): end ohlcv-1m at the minute, -1h at the hour, -1d at the day.
            reqs = [(s, _floor(end, s) - dt.timedelta(days=days[s]), _floor(end, s)) for s in SCHEMAS if days[s] > 0]
            cost = 0.0
            for schema, start, stop in reqs:
                cost += float(client.metadata.get_cost(dataset=DATASET, symbols=[store.contract], schema=schema, stype_in="raw_symbol",
                                                       start=_iso(start), end=_iso(stop)))
            store.estimated_cost_usd = round(cost, 4)
            store.range = {"start": _iso(min(r[1] for r in reqs)), "end": _iso(end)} if reqs else None
            if cost > self.cfg.hist_max_cost_usd:
                store.state = COST_BLOCKED
                store.message = (f"Historical download for {store.contract} estimated at ${cost:.2f} exceeds TLUXE_DB_HIST_MAX_COST_USD="
                                 f"{self.cfg.hist_max_cost_usd:.2f} - not downloaded. HISTORICAL DATA UNAVAILABLE beyond the live window.")
                log.warning("history %s: %s", store.root, store.message)
                return self._done(store)
            for schema, start, stop in reqs:
                data = client.timeseries.get_range(dataset=DATASET, symbols=[store.contract], schema=schema, stype_in="raw_symbol",
                                                   start=_iso(start), end=_iso(stop))
                for r in data:
                    store.add(schema, r)
            store.state = READY
            store.message = None
            log.info("history %s %s ready: %s (est. $%.4f)", store.root, store.contract, {s: len(b) for s, b in store.bars.items()}, cost)
        except Exception as exc:  # noqa: BLE001 - reported, never replaced by other data
            from .redact import Redactor

            msg = Redactor(self.cfg.api_key.reveal())(str(exc))
            kind, _schema = classify(msg)
            store.state = AUTH_ERROR if kind == AUTH else NOT_ENTITLED if kind == ENTITLEMENT else UNAVAILABLE
            store.message = f"Databento Historical API: {msg[:300]}"
            log.warning("history %s %s: %s", store.root, store.contract, store.state)
        return self._done(store)

    def _done(self, store: HistoryStore) -> HistoryStore:
        store.loaded_at_ms = self.now()
        self.on_loaded(store)
        return store

    # ---------------------------------------------------------------- refresh
    #
    # WHY THIS EXISTS. `load()` runs once per contract (hub.on_contract), so the
    # historical window ends at load time and never moves. The live CandleStore
    # keeps only `replay_hours * 60 + 120` minutes - 1560, or 26 traded-hours, at
    # the configured 24. `hub.candles()` serves the union of the two, so the
    # moment the bridge has been running more than that overlap past its load,
    # the oldest live minute is evicted past the historical end and a hole opens
    # between them. It then widens by an hour every hour.
    #
    # It is not a failure mode: it is what healthy, uninterrupted operation does.
    # Observed on 2026-10-29 - history ending 10-27 10:00, live buffer starting
    # 10-28 03:23, a 17.4 h hole, matching the arithmetic to four minutes.
    #
    # The fix is to reload history before the overlap is spent. `add()` is a
    # timestamp-keyed merge and `load()` never clears, so a reload fills holes
    # and rewrites identical official bars; live still wins at serve time.
    #
    # WHAT THIS MUST NOT DO, 1: downgrade a healthy store. A transient API failure
    # inside a refresh would otherwise flip a READY store to UNAVAILABLE and take
    # a good history off the air. So a refresh loads into a store nothing serves
    # and only publishes a result that succeeded. Bars already held are never
    # touched by a failure - nothing in this file deletes a bar.
    #
    # WHAT THIS MUST NOT DO, 2: write into a dict a consumer is reading. `load()`
    # writes bar by bar, while `hub.candles()` iterates those same dicts under
    # hub.lock, which the loader does not hold. Reloading into the SERVED store
    # would therefore raise "dictionary changed size during iteration" inside a
    # consumer's request - rarely, and every refresh cycle gets another chance at
    # it. Loading into a detached store and then REBINDING each finished schema
    # dict is one atomic assignment per schema: a reader holds a reference to one
    # complete dict or to the other, never to a mutating one.

    def refresh(self, store: HistoryStore) -> str:
        """Reload this store's contract into a DETACHED store, then publish it.

        Returns the state of THIS ATTEMPT, which is not always the store's reported
        state: a failed attempt over a healthy store leaves the store READY while
        returning UNAVAILABLE / COST_BLOCKED / AUTH_ERROR. The caller needs the
        attempt - scheduling on the store's state would treat a preserved READY as
        a success, give the next try the normal interval instead of a backoff, and
        never count the failure.
        """
        held = {s: len(b) for s, b in store.bars.items()}
        fresh = HistoryStore(store.root, store.contract, store.instrument_id)
        for schema, bars in store.bars.items():
            fresh.bars[schema] = dict(bars)       # start from what we already have: a reload may never lose a bar
        self.load(fresh)
        attempt = fresh.state

        if attempt == READY:
            for schema, bars in fresh.bars.items():
                store.bars[schema] = bars         # atomic per schema; no reader is ever mid-iteration
            store.state, store.message = READY, None
            store.range, store.estimated_cost_usd = fresh.range, fresh.estimated_cost_usd
            store.loaded_at_ms = fresh.loaded_at_ms
            gained = {s: len(b) - held.get(s, 0) for s, b in store.bars.items()}
            log.info("history %s refreshed: +%s bars", store.root,
                     {s: n for s, n in gained.items() if n})
            self.on_loaded(store)                 # republish the status of the store that is actually served
        elif store.state == READY:
            # The attempt failed, but what we already had is still good. Report the
            # old truth rather than a scare, and say why in the log only.
            log.warning("history %s refresh failed (%s); keeping the previous READY history",
                        store.root, attempt)
        else:
            # Nothing healthy to protect - report the latest attempt, as a first load would.
            store.state, store.message = fresh.state, fresh.message
            store.range, store.estimated_cost_usd = fresh.range, fresh.estimated_cost_usd
            store.loaded_at_ms = fresh.loaded_at_ms
        return attempt


class HistoryRefresher:
    """Reloads a root's history on a cadence shorter than the live overlap.

    Enabled PER ROOT, so GC can refresh while SI stays off entirely.

    `Manager` drives this from ONE background thread that steps the roots in turn
    (`manager._refresh_loop`), so there is no lock here and no thread of its own.
    What the roots do not share is state: `_inflight`, `_next_due` and `_failures`
    are keyed by root, every attempt builds its own Historical client, and no lock
    is held across a download - so a GC failure cannot touch SI's schedule, its
    failure count or its history, and cannot block a consumer reading either root.

    Because that one thread is sequential, a slow GC refresh does delay SI within
    the same tick. That delay is bounded: the Databento SDK applies a 100 s connect
    and read timeout to every request, so the worst case is minutes against a
    cadence of hours.

    A refresh already in flight is never started twice - `_inflight` is checked
    before anything else that could issue a request.
    """

    def __init__(self, cfg, loader, stores, now=time.time, sleep=time.sleep) -> None:
        self.cfg, self.loader, self.stores = cfg, loader, stores
        self.now, self.sleep = now, sleep
        self._stop = threading.Event()
        self._inflight: dict[str, bool] = {}
        self._next_due: dict[str, float] = {}
        self._failures: dict[str, int] = {}

    # CONFIGURATION, AND WHY IT READS THIS WAY.
    #
    # The first draft used 0 to mean "derive the interval from replay_hours". That
    # was a bad setting: 0 looks like off everywhere else in this codebase, so a
    # reader - or an operator reaching for the obvious way to disable it - would
    # have switched the feature ON with a derived cadence. Worse, it made the
    # production default enabled, which is the opposite of what is wanted while
    # this is new.
    #
    # So the states are named, and "off" means off. The setting is ALSO per root,
    # because rolling this feature out wants one instrument at a time:
    #
    #   "" / "0" / "off"    ->  EVERY root disabled. No timer and no automatic
    #                           request to the Historical API, ever. This is the
    #                           default, including when the variable is absent.
    #   "auto"              ->  every root, a quarter of the live overlap - which is
    #                           what keeps the historical window and the live buffer
    #                           touching.
    #   "<seconds>"         ->  every root, that interval, floored at 900 s so a
    #                           typo cannot hammer the API.
    #   "GC"                ->  GC on "auto"; every root NOT named stays OFF.
    #   "GC:auto"/"GC:21600"->  GC with that interval; SI off.
    #   "GC:auto,SI:28800"  ->  both, with independent intervals.
    #   "GC:auto,SI:off"    ->  the same as "GC:auto"; a per-root "off" is explicit.
    #
    # A root named in the value is enabled and a root absent from it is off, so the
    # safe direction is the default in both the global and the per-root form. An
    # unknown name is logged and ignored rather than guessed at.
    OFF_WORDS = ("", "0", "off", "false", "no", "disabled")

    def _interval(self, spec: str):
        """One interval spec -> seconds, or None for off / unparseable."""
        s = spec.strip().lower()
        if s in self.OFF_WORDS:
            return None
        if s == "auto":
            overlap_min = max(60, self.cfg.replay_hours * 60 + 120)
            return max(900.0, overlap_min * 60 / 4.0)
        try:
            return max(900.0, float(int(s)))
        except (TypeError, ValueError):
            log.warning("TLUXE_DB_HIST_REFRESH=%r is not 'auto', 'off', a number of seconds or a "
                        "per-instrument list such as 'GC:auto' - historical refresh stays DISABLED",
                        spec[:32])
            return None

    def plan(self) -> dict[str, float]:
        """{root: interval_s} for the roots that are enabled. A root absent is OFF."""
        raw = str(getattr(self.cfg, "hist_refresh", "") or "").strip()
        if raw.lower() in self.OFF_WORDS:
            return {}
        entries = [e.strip() for e in raw.split(",") if e.strip()]
        if not any(e.partition(":")[0].strip().upper() in ROOTS for e in entries):
            # No instrument named: the whole value is one interval for every root.
            secs = self._interval(raw)
            return {r: secs for r in ROOTS} if secs is not None else {}
        out: dict[str, float] = {}
        for entry in entries:
            head, _, spec = entry.partition(":")
            root = head.strip().upper()
            if root not in ROOTS:
                log.warning("TLUXE_DB_HIST_REFRESH: %r is not a known instrument root %s - ignored "
                            "(that instrument stays DISABLED)", head.strip()[:16], list(ROOTS))
                continue
            secs = self._interval(spec or "auto")
            if secs is not None:
                out[root] = secs
        return out

    def enabled(self, root: str) -> bool:
        return root in self.plan()

    def any_enabled(self) -> bool:
        """True when at least one root is enabled - what the manager's loop checks."""
        return bool(self.plan())

    def interval_s(self, root: str):
        """Seconds between refreshes of this root, or None when it is disabled."""
        return self.plan().get(root)

    def backoff_s(self, failures: int) -> float:
        return min(3600.0, 60.0 * (2 ** max(0, failures - 1)))

    def due(self, root: str) -> bool:
        if not self.enabled(root):
            return False
        return self.now() >= self._next_due.get(root, 0.0)

    def run_once(self, root: str) -> str:
        """One refresh attempt for one root. Returns a short outcome word.

        DISABLED is checked FIRST and unconditionally, for THIS root: a root that is
        off returns before a store, a timer or a client is touched, so no automatic
        call to the Historical API can originate here - including for an instrument
        left out of the configuration while another one is enabled.
        """
        if not self.enabled(root):
            return "DISABLED"
        if self._inflight.get(root):
            return "ALREADY_RUNNING"
        store = self.stores().get(root)
        if store is None:
            return "NO_STORE"
        if store.state == LOADING:
            # The contract's FIRST load is still running (startup, or a roll a moment
            # ago). A refresh now would download the same window a second time for
            # nothing, so wait for it; the next tick will find a settled store.
            return "LOADING"
        if not self.due(root):
            return "NOT_DUE"
        self._inflight[root] = True
        try:
            # The ATTEMPT, not store.state: a failed attempt over a healthy store
            # deliberately leaves the store READY, so reading the store here would
            # schedule a failure as a success and never back off.
            ok = self.loader.refresh(store) == READY
            self._failures[root] = 0 if ok else self._failures.get(root, 0) + 1
            wait = self.interval_s(root) if ok else self.backoff_s(self._failures[root])
            self._next_due[root] = self.now() + wait
            return "REFRESHED" if ok else "FAILED"
        finally:
            self._inflight[root] = False
