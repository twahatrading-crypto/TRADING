"""Normalized market-data hub: the ONE place Databento records become TLUXE state.

Record flow:  Databento Live callback -> ingest queue -> worker (this hub, under one lock) -> per-root state
(order book, trade tape, candles) -> frames (published every publish_ms, bounded ring) -> HTTP API -> browser.

Nothing here invents data: levels come from the reconstructed MBO book, trades from the `trades` schema, bars
from `ohlcv-1m`. Unknown / malformed input is counted and surfaced, never repaired.

Plans: on CME Globex MDP 3.0 Standard (the default) there is NO order book - mbo / mbp-10 are never requested and
depth is reported as UNSUPPORTED (never approximated). A schema the gateway reports as not entitled is marked
NOT_ENTITLED for that schema only; it is never an authentication failure of the whole provider.
"""
from __future__ import annotations

import threading
import time
from collections import deque

from .book import DEGRADED, INVALID, NO_DATA, SYNCING, VALID, OrderBook, _s
from .candles import CandleStore
from .config import DATASET, DEPTH_SCHEMA, NEVER_REQUESTED, ROOTS, TAPE_SCHEMAS, BridgeConfig
from .entitlement import AUTH, ENTITLEMENT, START, classify, parse_start_boundary_ns
from .redact import Redactor
from .symbology import SymbolMap
from .tape import TradeTape

# Provider status (shared model, also used by the browser).
CONNECTING, SYNCING_S, LIVE, DEGRADED_S, STALE, RECONNECTING, UNAVAILABLE, AUTH_ERROR = (
    "CONNECTING", "SYNCING", "LIVE", "DEGRADED", "STALE", "RECONNECTING", "UNAVAILABLE", "AUTH_ERROR")

MBO_DUP_WINDOW = 4096
MAPPING_TIMEOUT_MS = 60_000
TAPE_GAP_FLAG_MS = 10 * 60_000
# After the gateway names the earliest allowed replay start, request this much later (its boundary moves forward
# with time and is aligned by the gateway, so the exact value may already be stale when we reconnect).
START_BOUNDARY_PAD_NS = 2 * 60 * 1_000_000_000
MINUTE_NS = 60 * 1_000_000_000
STANDARD_DEPTH_REASON = "Databento Standard does not include real-time MBO/MBP-10"
LEVEL2_REQUIRED = "Level-2 provider required: IBKR / T4 / other supported depth provider"
# Per-capability states reported to the browser.
CAP_LIVE, CAP_STALE, CAP_OFFLINE, CAP_WAITING, CAP_NOT_ENTITLED, CAP_UNSUPPORTED, CAP_UNAVAILABLE = (
    "LIVE", "STALE", "OFFLINE", "WAITING", "NOT_ENTITLED", "UNSUPPORTED", "UNAVAILABLE")
_CAP_RANK = (CAP_LIVE, CAP_STALE, CAP_WAITING, CAP_OFFLINE, CAP_UNAVAILABLE, CAP_NOT_ENTITLED)


class SessionState:
    def __init__(self, name: str) -> None:
        self.name = name
        self.state = "IDLE"  # IDLE | CONNECTING | CONNECTED | RECONNECTING | AUTH_ERROR | UNAVAILABLE | STOPPED | DISABLED
        self.connected_at: int | None = None
        self.ever_connected = False
        self.reconnects = 0
        self.resyncs = 0
        self.last_msg_ms: int | None = None
        self.last_error: dict | None = None
        self.storm = False

    def view(self) -> dict:
        return {"state": self.state, "connectedAtMs": self.connected_at, "reconnects": self.reconnects, "resyncs": self.resyncs,
                "lastMessageMs": self.last_msg_ms, "lastError": self.last_error, "reconnectStorm": self.storm}


class RootState:
    def __init__(self, root: str, symbol: str, stype: str) -> None:
        self.root = root
        self.symbol = symbol
        self.stype = stype
        self.book: OrderBook | None = None
        self.tape: TradeTape | None = None
        self.candles: CandleStore | None = None
        self.contract: str | None = None
        self.instrument_id: int | None = None
        self.framed_epoch = -1
        self.pending_trades: list = []
        self.pending_bars: dict = {}
        self.mbo_keys: deque = deque()
        self.mbo_keyset: set = set()
        self.counts = {"mbo": 0, "trades": 0, "ohlcv": 0, "mboDuplicates": 0, "tapeGaps": 0, "rolls": 0}
        self.last_event_ns: int | None = None
        self.last_recv_ns: int | None = None
        self.tape_gap_at: int | None = None
        self.roll_note: dict | None = None


class Hub:
    def __init__(self, cfg: BridgeConfig, clock=lambda: int(time.time() * 1000)) -> None:
        self.cfg = cfg
        self.now = clock
        self.lock = threading.RLock()
        self.redact = Redactor(cfg.api_key.reveal(), cfg.token.reveal())
        self.roots: dict[str, RootState] = {}
        symbols = {}
        for root in ROOTS:
            sym, stype = cfg.symbol_for(root)
            self.roots[root] = RootState(root, sym, stype)
            symbols[sym] = root
        self.symmap = SymbolMap(symbols)
        self.sessions = {"book": SessionState("book"), "tape": SessionState("tape")}
        # Schema entitlement as known to the bridge. "plan": excluded by the configured Databento plan (never
        # requested); "gateway": the Databento gateway rejected the subscription for that schema.
        self.schema_state: dict[str, dict] = {}
        if not cfg.depth_plan:
            for schema in (DEPTH_SCHEMA, *NEVER_REQUESTED):
                self.schema_state[schema] = {"state": CAP_NOT_ENTITLED, "source": "plan", "message": f"{STANDARD_DEPTH_REASON} - not requested."}
            self.sessions["book"].state = "DISABLED"
        else:
            for schema in NEVER_REQUESTED:
                self.schema_state[schema] = {"state": "NOT_REQUESTED", "source": "plan", "message": "Never requested by this bridge."}
        self.frames: deque = deque(maxlen=cfg.max_frames)
        self.cursor = 0
        self.started_ms = self.now()
        self.resync_requests: dict[str, str | None] = {"book": None, "tape": None}
        # Intraday replay start control ("Invalid start time. Must be ... or later" recovery).
        self.replay_floor_ns: int | None = None  # earliest start the gateway accepts (from its error), padded
        self.replay_disabled_reason: str | None = None  # live-only fallback after repeated start rejections
        self.start_error_pending = False
        self.start_rejections = 0
        self.last_replay_start_ns: int | None = None
        self.metrics = {"records": 0, "unmapped": 0, "unknownRecords": 0, "malformed": 0, "queueDepth": 0, "maxQueueDepth": 0,
                        "ingestLagMs": None, "maxIngestLagMs": 0, "tapeLagMs": None, "published": 0, "processingMs": 0.0, "systemMessages": 0, "errors": 0}
        self._rate = deque(maxlen=64)  # (ms, records) samples for the ingest rate
        self.last_roll: list = []

    # ------------------------------------------------------------------ plan / entitlement
    def not_entitled(self, schema: str) -> bool:
        return self.schema_state.get(schema, {}).get("state") == CAP_NOT_ENTITLED

    def depth_active(self) -> bool:
        """An MBO order book is maintained only on a plan that includes MBO and while MBO is not rejected."""
        return self.cfg.depth_plan and not self.not_entitled(DEPTH_SCHEMA)

    def requested_schemas(self, session: str) -> list[str]:
        """Exactly the schemas a session subscribes to now. Never mbp-10; never mbo on Standard; never a schema the
        gateway already rejected (no subscribe / reject / reconnect loop)."""
        with self.lock:
            if session == "book":
                return [DEPTH_SCHEMA] if self.depth_active() else []
            return [sc for sc in TAPE_SCHEMAS if not self.not_entitled(sc)]

    # ------------------------------------------------------------------ records
    def on_record(self, session: str, r, recv_ms: int | None = None) -> None:
        with self.lock:
            self.metrics["records"] += 1
            s = self.sessions[session]
            s.last_msg_ms = recv_ms if recv_ms is not None else self.now()
            kind = type(r).__name__
            if kind == "SymbolMappingMsg":
                return self._mapping(r)
            if kind == "SystemMsg":
                self.metrics["systemMessages"] += 1
                return
            if kind == "ErrorMsg":
                return self.on_error(session, str(getattr(r, "err", "")), fatal=False)
            ts_recv = getattr(r, "ts_recv", None)
            if ts_recv:
                lag = max(0, (recv_ms if recv_ms is not None else self.now()) - ts_recv // 1_000_000)
                if kind == "MBOMsg" and not int(getattr(r, "flags", 0) or 0) & 32:
                    # Live (non-snapshot) MBO only: replayed / snapshot records legitimately carry older ts_recv.
                    self.metrics["ingestLagMs"] = lag
                    self.metrics["maxIngestLagMs"] = max(self.metrics["maxIngestLagMs"], lag)
                elif kind == "TradeMsg":
                    self.metrics["tapeLagMs"] = lag
            iid = getattr(r, "instrument_id", None)
            root_name = self.symmap.root_of(int(iid)) if iid is not None else None
            if root_name is None:
                self.metrics["unmapped" if kind in ("MBOMsg", "TradeMsg", "OHLCVMsg") else "unknownRecords"] += 1
                return
            st = self.roots[root_name]
            if kind == "MBOMsg" and session == "book":
                return self._mbo(st, r)
            if kind == "TradeMsg" and session == "tape":
                return self._trade(st, r)
            if kind == "OHLCVMsg" and session == "tape":
                st.counts["ohlcv"] += 1
                if st.candles and st.candles.on_ohlcv(r):
                    t = int(r.ts_event) // 1_000_000_000
                    st.pending_bars[t] = st.candles.bars.get(t)
                return
            self.metrics["unknownRecords"] += 1

    def _mapping(self, r) -> None:
        self.start_rejections = 0  # the gateway accepted the subscription (start included)
        change = self.symmap.on_mapping(r, self.now())
        if change is None:
            return
        root, prev, new = change
        st = self.roots[root]
        st.contract, st.instrument_id = new.contract, new.instrument_id
        st.book = OrderBook(new.instrument_id) if self.depth_active() else None
        st.tape = TradeTape(root, new.contract, new.instrument_id, self.cfg.max_trades)
        st.candles = CandleStore(new.instrument_id, max_bars=max(60, self.cfg.replay_hours * 60 + 120))
        st.pending_trades, st.pending_bars, st.framed_epoch = [], {}, -1
        st.mbo_keys.clear()
        st.mbo_keyset.clear()
        if prev is not None:
            # ROLL: never merge contracts - new book (needs a fresh snapshot), new tape, new candle history.
            st.counts["rolls"] += 1
            st.roll_note = {"from": prev.contract, "to": new.contract, "fromId": prev.instrument_id, "toId": new.instrument_id, "atMs": self.now()}
            if self.depth_active():
                self.request_resync("book", f"contract roll {root}: {prev.contract} -> {new.contract}")
            self.request_resync("tape", f"contract roll {root}: history for {new.contract}")

    def _mbo(self, st: RootState, r) -> None:
        book = st.book
        if book is None or int(r.instrument_id) != book.instrument_id:
            self.metrics["unmapped"] += 1
            return
        key = (int(r.ts_recv), int(getattr(r, "sequence", 0) or 0), int(r.order_id), _s(r.action), _s(r.side), int(r.price), int(r.size), int(r.flags or 0))
        if key in st.mbo_keyset:
            st.counts["mboDuplicates"] += 1
            return
        st.mbo_keyset.add(key)
        st.mbo_keys.append(key)
        if len(st.mbo_keys) > MBO_DUP_WINDOW:
            st.mbo_keyset.discard(st.mbo_keys.popleft())
        st.counts["mbo"] += 1
        before = book.state
        book.apply(r)
        st.last_event_ns = max(st.last_event_ns or 0, int(r.ts_event))
        st.last_recv_ns = max(st.last_recv_ns or 0, int(r.ts_recv))
        if book.state in (DEGRADED, INVALID) and before != book.state:
            self.request_resync("book", f"{st.root}: {book.reason}")

    def _trade(self, st: RootState, r) -> None:
        tape = st.tape
        if tape is None or int(r.instrument_id) != tape.instrument_id:
            self.metrics["unmapped"] += 1
            return
        t = tape.add(r)
        if t is None:
            return
        st.counts["trades"] += 1
        st.pending_trades.append(t)
        if st.candles:
            st.candles.on_trade(t)
        st.last_event_ns = max(st.last_event_ns or 0, t["tsEventNs"])
        st.last_recv_ns = max(st.last_recv_ns or 0, t["tsRecvNs"])

    # ------------------------------------------------------------------ sessions
    def on_error(self, session: str, message: str, fatal: bool) -> str:
        """Record a gateway / SDK error. Returns AUTH | ENTITLEMENT | ERROR.

        ENTITLEMENT with a schema ("Not authorized for mbo schema") disables that schema only - the session keeps
        (or reconnects with) its other schemas. AUTH_ERROR is reserved for a genuine authentication failure."""
        with self.lock:
            msg = self.redact(message)[:300]
            kind, schema = classify(msg)
            self.metrics["errors"] += 1
            s = self.sessions[session]
            code = "AUTH_ERROR" if kind == AUTH else "NOT_ENTITLED" if kind == ENTITLEMENT else "ERROR"
            s.last_error = {"code": code, "message": msg, "atMs": self.now(), "schema": schema}
            if kind == START:
                # The replay start was outside Databento's intraday window. Not an auth / entitlement problem:
                # remember the gateway's boundary and reconnect ONCE with a valid start (bounded by the manager).
                code = "START_TIME"
                s.last_error["code"] = code
                self.start_rejections += 1
                self.start_error_pending = True
                boundary = parse_start_boundary_ns(msg)
                if boundary is not None:
                    floor = boundary + START_BOUNDARY_PAD_NS
                else:
                    # Boundary not stated in a form we can parse: step one hour further inside the window instead.
                    floor = self.replay_window_start_ns() + 60 * MINUTE_NS
                self.replay_floor_ns = max(self.replay_floor_ns or 0, floor)
                if not fatal:
                    self.request_resync(session, "replay start rejected by the gateway - reconnecting with a valid start")
            elif kind == AUTH:
                s.state = AUTH_ERROR
            elif kind == ENTITLEMENT:
                own = [DEPTH_SCHEMA] if session == "book" else list(TAPE_SCHEMAS)
                targets = [schema] if schema else own  # no schema named -> the session's dataset access itself
                for sc in targets:
                    self.schema_state[sc] = {"state": CAP_NOT_ENTITLED, "source": "gateway", "message": msg}
                depth_lost = DEPTH_SCHEMA in targets and self.cfg.depth_plan
                if depth_lost:
                    for st in self.roots.values():
                        st.book, st.framed_epoch = None, -1
                if not any(not self.not_entitled(sc) for sc in own):
                    s.state = UNAVAILABLE  # nothing left to subscribe on this session: it stops (no retry loop)
                if not fatal and (depth_lost or schema in own or s.state == UNAVAILABLE):
                    # In-stream error on an open session: close it; the runner re-subscribes without the schema
                    # (or stops when nothing entitled is left).
                    self.request_resync(session, f"not entitled: {schema or 'dataset'}")
            return kind

    def on_session_connected(self, session: str) -> None:
        with self.lock:
            s = self.sessions[session]
            s.state = "CONNECTED"
            s.connected_at = self.now()
            s.last_msg_ms = self.now()
            s.ever_connected = True
            if session == "tape":
                for st in self.roots.values():
                    if st.tape:
                        st.tape.reset_occurrences()

    def on_session_closed(self, session: str, reconnecting: bool) -> None:
        with self.lock:
            s = self.sessions[session]
            if s.state not in (AUTH_ERROR, UNAVAILABLE, "DISABLED"):
                s.state = RECONNECTING if reconnecting else "STOPPED"
            if session == "book":
                for st in self.roots.values():
                    if st.book is not None:
                        # The book is no longer being updated: frozen, never shown as live.
                        st.book.invalidate("Databento MBO session disconnected - book frozen until a new snapshot")
                        st.book = OrderBook(st.book.instrument_id)
                        st.framed_epoch = -1

    def request_resync(self, session: str, reason: str) -> None:
        with self.lock:
            if self.resync_requests.get(session) is None:
                self.resync_requests[session] = reason

    def take_resync(self, session: str) -> str | None:
        with self.lock:
            r = self.resync_requests.get(session)
            self.resync_requests[session] = None
            return r

    def replay_window_start_ns(self) -> int:
        """Earliest start this bridge will request: `replay_hours` back, kept `replay_margin_min` inside Databento's
        rolling intraday window, rounded UP to a whole minute, and never before a boundary the gateway reported."""
        start = (self.now() - self.cfg.replay_hours * 3_600_000 + self.cfg.replay_margin_min * 60_000) * 1_000_000
        start = -(-start // MINUTE_NS) * MINUTE_NS
        if self.replay_floor_ns is not None:
            start = max(start, self.replay_floor_ns)
        return min(start, self.now() * 1_000_000)  # never in the future

    def take_start_error(self) -> bool:
        with self.lock:
            v, self.start_error_pending = self.start_error_pending, False
            return v

    def disable_replay(self, reason: str) -> None:
        """Live-only fallback (no `start`): used only after repeated start rejections. History before the connect is
        then missing - flagged as a gap, never filled."""
        with self.lock:
            if self.replay_disabled_reason is None:
                self.replay_disabled_reason = reason
                self.note_tape_gap(reason)

    def tape_replay_start_ns(self) -> int | None:
        """Replay start for the trades / ohlcv session: overlap before the oldest root's last trade, or the full
        replay window for a root without history. A root whose history is older than the window gets a GAP flag.
        None = live only (replay disabled after repeated start rejections)."""
        with self.lock:
            if self.replay_disabled_reason is not None:
                self.last_replay_start_ns = None
                return None
            window_start = self.replay_window_start_ns()
            starts = []
            for st in self.roots.values():
                s = st.tape.replay_start_ns() if st.tape else None
                if s is None:
                    starts.append(window_start)
                elif s < window_start:
                    st.counts["tapeGaps"] += 1
                    st.tape_gap_at = self.now()
                    starts.append(window_start)
                else:
                    starts.append(s)
            self.last_replay_start_ns = max(min(starts), window_start)
            return self.last_replay_start_ns

    def note_tape_gap(self, reason: str) -> None:
        with self.lock:
            for st in self.roots.values():
                st.counts["tapeGaps"] += 1
                st.tape_gap_at = self.now()
            self.sessions["tape"].last_error = {"code": "GAP", "message": reason, "atMs": self.now()}

    def set_queue_depth(self, depth: int) -> None:
        self.metrics["queueDepth"] = depth
        self.metrics["maxQueueDepth"] = max(self.metrics["maxQueueDepth"], depth)

    # ------------------------------------------------------------------ status
    def root_status(self, st: RootState) -> dict:
        now = self.now()
        b, t = self.sessions["book"], self.sessions["tape"]
        depth = self.depth_active()
        needed = [t, b] if depth else [t]  # Standard: the provider status depends on the trades/ohlcv session only
        reasons: list[str] = []
        if any(s.state == AUTH_ERROR for s in needed):
            status = AUTH_ERROR
            reasons.append("Databento rejected the API key (authentication failed).")
        elif t.state == UNAVAILABLE:
            status = UNAVAILABLE
            reasons.append((t.last_error or {}).get("message", "Databento reported the data as unavailable."))
        elif any(s.state != "CONNECTED" for s in needed):
            status = RECONNECTING if any(s.ever_connected for s in needed) else CONNECTING
        elif st.instrument_id is None:
            status = UNAVAILABLE if now - (t.connected_at or now) > MAPPING_TIMEOUT_MS else CONNECTING
            reasons.append("Waiting for Databento symbol mapping (actual contract).")
        elif depth and (st.book is None or st.book.state in (SYNCING, INVALID, NO_DATA)):
            status = SYNCING_S
            reasons.append("SYNCING BOOK - waiting for the complete MBO snapshot.")
        else:
            status = LIVE
            if depth and st.book is not None and st.book.state == DEGRADED:
                status = DEGRADED_S
                reasons.append(st.book.reason or "Book integrity degraded.")
            lag = self.metrics["ingestLagMs"]
            if depth and lag is not None and lag > self.cfg.lag_ms:
                status = DEGRADED_S
                reasons.append(f"Consumer behind the feed: ingest lag {lag} ms.")
            if self.metrics["queueDepth"] > 50_000:
                status = DEGRADED_S
                reasons.append(f"Ingest backlog {self.metrics['queueDepth']} records.")
            if st.tape_gap_at is not None and now - st.tape_gap_at < TAPE_GAP_FLAG_MS:
                status = DEGRADED_S
                reasons.append("Trade history gap (outage longer than the replay window) - never filled.")
            if any(s.storm for s in needed):
                status = DEGRADED_S
                reasons.append("Reconnect storm - backing off.")
            if max(now - (s.last_msg_ms or 0) for s in needed) > self.cfg.stale_ms:
                status = STALE
                reasons.append("No Databento message (data or heartbeat) within the stale window.")
        freshness = ("UNAVAILABLE" if status in (AUTH_ERROR, UNAVAILABLE) else "OFFLINE" if status in (CONNECTING, RECONNECTING) else
                     "STALE" if status == STALE else "DELAYED" if depth and (self.metrics["ingestLagMs"] or 0) > self.cfg.lag_ms else "LIVE")
        caps = self.capabilities(st, status)
        book = st.book
        return {
            "root": st.root,
            "provider": "Databento",
            "dataset": DATASET,
            "subscribed": st.symbol,
            "stypeIn": st.stype,
            "contract": st.contract,
            "instrumentId": st.instrument_id,
            "status": status,
            "freshness": freshness,
            "reasons": reasons,
            "plan": self.cfg.plan,
            "capabilities": caps,
            "book": {"state": book.state if book else NO_DATA, "epoch": book.epoch if book else 0, "reason": book.reason if book else None,
                     "orders": len(book.orders) if book else 0, "bidLevels": len(book.levels["B"]) if book else 0, "askLevels": len(book.levels["A"]) if book else 0,
                     "counts": dict(book.counts) if book else {}, "best": list(book.best()) if book else [None, None]},
            "tape": {"replaying": (self.metrics["tapeLagMs"] or 0) > self.cfg.lag_ms, "lagMs": self.metrics["tapeLagMs"], "contract": st.tape.contract if st.tape else None, "counts": dict(st.tape.counts) if st.tape else {}, "volume": dict(st.tape.volume) if st.tape else {},
                     "retained": len(st.tape.trades) if st.tape else 0, "lastIndex": st.tape.index if st.tape else 0},
            "candles": {"bars": len(st.candles.bars) if st.candles else 0, "lastClosed": st.candles.last_closed if st.candles else None},
            "lastEventNs": st.last_event_ns,
            "lastRecvNs": st.last_recv_ns,
            "lastEventAgeMs": None if st.last_event_ns is None else max(0, now - st.last_event_ns // 1_000_000),
            "counts": dict(st.counts),
            "roll": st.roll_note,
        }

    def capabilities(self, st: RootState, status: str) -> dict:
        """Capability-based status: each data kind is reported on its own, so missing depth never takes the
        trades / OHLCV / volume path down (and vice versa)."""
        now = self.now()
        t = self.sessions["tape"]

        def cap(schema: str, observed: bool) -> str:
            if self.not_entitled(schema):
                return CAP_NOT_ENTITLED
            if status == AUTH_ERROR or t.state in (AUTH_ERROR, UNAVAILABLE):
                return CAP_UNAVAILABLE
            if t.state != "CONNECTED":
                return CAP_OFFLINE
            if now - (t.last_msg_ms or 0) > self.cfg.stale_ms:
                return CAP_STALE
            return CAP_LIVE if observed else CAP_WAITING  # WAITING = connected, no record observed yet (quiet / closed)

        trades = cap("trades", st.counts["trades"] > 0)
        ohlcv = cap("ohlcv-1m", st.counts["ohlcv"] > 0)
        volume = min((trades, ohlcv), key=_CAP_RANK.index)
        if not self.cfg.depth_plan:
            depth, depth_reason = CAP_UNSUPPORTED, STANDARD_DEPTH_REASON
        elif self.not_entitled(DEPTH_SCHEMA):
            depth, depth_reason = CAP_NOT_ENTITLED, self.schema_state[DEPTH_SCHEMA]["message"]
        else:
            bs = st.book.state if st.book is not None else NO_DATA
            depth = {VALID: CAP_LIVE, DEGRADED: "DEGRADED", SYNCING: "SYNCING"}.get(bs, CAP_OFFLINE)
            depth_reason = None if depth == CAP_LIVE else (st.book.reason if st.book is not None else None)
        mbo_state = self.schema_state.get(DEPTH_SCHEMA, {}).get("state") or ("ENTITLED" if st.counts["mbo"] > 0 else "REQUESTED")
        return {
            "trades": trades,
            "ohlcv": ohlcv,
            "volume": volume,
            "depth": depth,
            "depthReason": depth_reason,
            "mbo": mbo_state,
            "mbp10": self.schema_state.get("mbp-10", {}).get("state", "NOT_REQUESTED"),
            "level2Provider": "NOT_CONNECTED" if depth != CAP_LIVE else "DATABENTO_MBO",
            "level2Required": LEVEL2_REQUIRED if depth in (CAP_UNSUPPORTED, CAP_NOT_ENTITLED) else None,
        }

    def health(self) -> dict:
        with self.lock:
            now = self.now()
            rate = 0.0
            if len(self._rate) >= 2:
                (t0, n0), (t1, n1) = self._rate[0], self._rate[-1]
                rate = (n1 - n0) / max(0.001, (t1 - t0) / 1000)
            return {
                "provider": "Databento",
                "dataset": DATASET,
                "contractMode": self.cfg.contract_mode,
                "plan": self.cfg.plan,
                "schemas": {"requested": {k: self.requested_schemas(k) for k in self.sessions}, "entitlements": {k: dict(v) for k, v in self.schema_state.items()}},
                "sessions": {k: v.view() for k, v in self.sessions.items()},
                "instruments": {root: self.root_status(st) for root, st in self.roots.items()},
                "rolls": list(self.symmap.rolls),
                "metrics": {**self.metrics, "ingestRatePerSec": round(rate, 1), "frames": len(self.frames), "cursor": self.cursor},
                "retention": {"maxTrades": self.cfg.max_trades, "maxFrames": self.cfg.max_frames, "publishMs": self.cfg.publish_ms, "replayHours": self.cfg.replay_hours},
                "replay": {"requestedStartNs": self.last_replay_start_ns, "floorNs": self.replay_floor_ns, "marginMin": self.cfg.replay_margin_min,
                           "liveOnly": self.replay_disabled_reason is not None, "liveOnlyReason": self.replay_disabled_reason, "startRejections": self.start_rejections},
                "timeMs": now,
            }

    # ------------------------------------------------------------------ frames
    def publish(self) -> dict | None:
        """Build one frame from everything that changed since the previous frame (batched / coalesced)."""
        with self.lock:
            t0 = time.perf_counter()
            self._rate.append((self.now(), self.metrics["records"]))
            instruments = {}
            for root, st in self.roots.items():
                f: dict = {"contract": st.contract, "instrumentId": st.instrument_id, "status": self.root_status(st)}
                book = st.book
                if book is not None and book.publishable:
                    if book.epoch != st.framed_epoch:
                        f["snapshot"] = {"epoch": book.epoch, **book.snapshot()}
                        book.take_dirty()
                        st.framed_epoch = book.epoch
                    else:
                        levels = book.take_dirty()
                        if levels:
                            f["levels"] = levels
                if st.pending_trades:
                    f["trades"] = st.pending_trades
                    st.pending_trades = []
                if st.pending_bars:
                    f["bars"] = [b for b in st.pending_bars.values() if b]
                    st.pending_bars = {}
                if st.candles and st.candles.forming:
                    f["forming"] = dict(st.candles.forming)
                instruments[root] = f
            self.cursor += 1
            frame = {"cursor": self.cursor, "timeMs": self.now(), "instruments": instruments}
            self.frames.append(frame)
            self.metrics["published"] += 1
            self.metrics["processingMs"] = round((time.perf_counter() - t0) * 1000, 3)
            return frame

    def frames_after(self, cursor: int, roots: list[str] | None = None) -> dict:
        with self.lock:
            oldest = self.frames[0]["cursor"] if self.frames else self.cursor + 1
            reset = cursor < oldest - 1 or cursor > self.cursor
            out = [f for f in self.frames if f["cursor"] > cursor]
            if roots:
                out = [{**f, "instruments": {k: v for k, v in f["instruments"].items() if k in roots}} for f in out]
            return {"cursor": self.cursor, "reset": reset, "frames": out if not reset else []}

    def book_snapshot(self, root: str) -> dict:
        with self.lock:
            st = self.roots[root]
            book = st.book
            valid = book is not None and book.state in (VALID, DEGRADED) and not book.mid_event
            return {"root": root, "contract": st.contract, "instrumentId": st.instrument_id, "cursor": self.cursor,
                    "state": book.state if book else NO_DATA, "epoch": book.epoch if book else 0,
                    "book": book.snapshot() if valid else None, "lastEventNs": st.last_event_ns, "lastRecvNs": st.last_recv_ns}

    def trades_after(self, root: str, index: int, limit: int) -> dict:
        with self.lock:
            st = self.roots[root]
            if st.tape is None:
                return {"root": root, "contract": None, "trades": [], "complete": False, "lastIndex": 0, "cursor": self.cursor}
            trades, complete = st.tape.since(index, limit)
            return {"root": root, "contract": st.tape.contract, "instrumentId": st.tape.instrument_id, "trades": trades, "complete": complete, "lastIndex": st.tape.index, "cursor": self.cursor}

    def candles(self, root: str, tf: str, limit: int) -> dict:
        with self.lock:
            st = self.roots[root]
            bars = st.candles.get(tf, limit) if st.candles else []
            return {"root": root, "contract": st.contract, "instrumentId": st.instrument_id, "timeframe": tf, "bars": bars,
                    "source": "databento", "schema": "ohlcv-1m", "cursor": self.cursor}
