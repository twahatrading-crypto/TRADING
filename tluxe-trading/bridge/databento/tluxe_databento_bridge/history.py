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
from .config import DATASET

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
