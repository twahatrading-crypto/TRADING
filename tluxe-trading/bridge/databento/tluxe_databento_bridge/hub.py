"""Normalized market-data hub: the ONE place Databento records become TLUXE state.

Record flow:  Databento Live callback -> ingest queue -> worker (this hub, under one lock) -> per-root state
(order book, trade tape, candles) -> frames (published every publish_ms, bounded ring) -> HTTP API -> browser.

Nothing here invents data: levels come from the reconstructed MBO book, trades from the `trades` schema, bars
from `ohlcv-1m`. Unknown / malformed input is counted and surfaced, never repaired.
"""
from __future__ import annotations

import threading
import time
from collections import deque

from .book import DEGRADED, INVALID, NO_DATA, SYNCING, VALID, OrderBook, _s
from .candles import CandleStore
from .config import DATASET, ROOTS, BridgeConfig
from .redact import Redactor
from .symbology import SymbolMap
from .tape import TradeTape

# Provider status (shared model, also used by the browser).
CONNECTING, SYNCING_S, LIVE, DEGRADED_S, STALE, RECONNECTING, UNAVAILABLE, AUTH_ERROR = (
    "CONNECTING", "SYNCING", "LIVE", "DEGRADED", "STALE", "RECONNECTING", "UNAVAILABLE", "AUTH_ERROR")

MBO_DUP_WINDOW = 4096
MAPPING_TIMEOUT_MS = 60_000
TAPE_GAP_FLAG_MS = 10 * 60_000


class SessionState:
    def __init__(self, name: str) -> None:
        self.name = name
        self.state = "IDLE"  # IDLE | CONNECTING | CONNECTED | RECONNECTING | AUTH_ERROR | UNAVAILABLE | STOPPED
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
        self.frames: deque = deque(maxlen=cfg.max_frames)
        self.cursor = 0
        self.started_ms = self.now()
        self.resync_requests: dict[str, str | None] = {"book": None, "tape": None}
        self.metrics = {"records": 0, "unmapped": 0, "unknownRecords": 0, "malformed": 0, "queueDepth": 0, "maxQueueDepth": 0,
                        "ingestLagMs": None, "maxIngestLagMs": 0, "tapeLagMs": None, "published": 0, "processingMs": 0.0, "systemMessages": 0, "errors": 0}
        self._rate = deque(maxlen=64)  # (ms, records) samples for the ingest rate
        self.last_roll: list = []

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
        change = self.symmap.on_mapping(r, self.now())
        if change is None:
            return
        root, prev, new = change
        st = self.roots[root]
        st.contract, st.instrument_id = new.contract, new.instrument_id
        st.book = OrderBook(new.instrument_id)
        st.tape = TradeTape(root, new.contract, new.instrument_id, self.cfg.max_trades)
        st.candles = CandleStore(new.instrument_id, max_bars=max(60, self.cfg.replay_hours * 60 + 120))
        st.pending_trades, st.pending_bars, st.framed_epoch = [], {}, -1
        st.mbo_keys.clear()
        st.mbo_keyset.clear()
        if prev is not None:
            # ROLL: never merge contracts - new book (needs a fresh snapshot), new tape, new candle history.
            st.counts["rolls"] += 1
            st.roll_note = {"from": prev.contract, "to": new.contract, "fromId": prev.instrument_id, "toId": new.instrument_id, "atMs": self.now()}
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
    def on_error(self, session: str, message: str, fatal: bool) -> None:
        with self.lock:
            msg = self.redact(message)[:300]
            low = msg.lower()
            code = "AUTH_ERROR" if ("auth" in low or "api key" in low or "unauthor" in low) else "ENTITLEMENT" if ("entitle" in low or "licen" in low or "permission" in low or "not authorized" in low) else "ERROR"
            self.metrics["errors"] += 1
            s = self.sessions[session]
            s.last_error = {"code": code, "message": msg, "atMs": self.now()}
            if code == "AUTH_ERROR":
                s.state = AUTH_ERROR
            elif code == "ENTITLEMENT":
                s.state = UNAVAILABLE

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
            if s.state not in (AUTH_ERROR, UNAVAILABLE):
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

    def tape_replay_start_ns(self) -> int:
        """Replay start for the trades / ohlcv session: overlap before the oldest root's last trade, or the full
        replay window for a root without history. A root whose history is older than the window gets a GAP flag."""
        with self.lock:
            window_start = (self.now() - self.cfg.replay_hours * 3_600_000) * 1_000_000
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
            return max(min(starts), window_start)

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
        reasons: list[str] = []
        if AUTH_ERROR in (b.state, t.state):
            status = AUTH_ERROR
            reasons.append("Databento rejected the API key (authentication failed).")
        elif UNAVAILABLE in (b.state, t.state):
            status = UNAVAILABLE
            reasons.append((b.last_error or t.last_error or {}).get("message", "Databento reported the data as unavailable."))
        elif b.state != "CONNECTED" or t.state != "CONNECTED":
            status = RECONNECTING if (b.ever_connected or t.ever_connected) else CONNECTING
        elif st.instrument_id is None:
            status = UNAVAILABLE if now - (b.connected_at or now) > MAPPING_TIMEOUT_MS else CONNECTING
            reasons.append("Waiting for Databento symbol mapping (actual contract).")
        elif st.book is None or st.book.state in (SYNCING, INVALID, NO_DATA):
            status = SYNCING_S
            reasons.append("SYNCING BOOK - waiting for the complete MBO snapshot.")
        else:
            status = LIVE
            if st.book.state == DEGRADED:
                status = DEGRADED_S
                reasons.append(st.book.reason or "Book integrity degraded.")
            lag = self.metrics["ingestLagMs"]
            if lag is not None and lag > self.cfg.lag_ms:
                status = DEGRADED_S
                reasons.append(f"Consumer behind the feed: ingest lag {lag} ms.")
            if self.metrics["queueDepth"] > 50_000:
                status = DEGRADED_S
                reasons.append(f"Ingest backlog {self.metrics['queueDepth']} records.")
            if st.tape_gap_at is not None and now - st.tape_gap_at < TAPE_GAP_FLAG_MS:
                status = DEGRADED_S
                reasons.append("Trade history gap (outage longer than the replay window) - never filled.")
            if b.storm or t.storm:
                status = DEGRADED_S
                reasons.append("Reconnect storm - backing off.")
            if max(now - (b.last_msg_ms or 0), now - (t.last_msg_ms or 0)) > self.cfg.stale_ms:
                status = STALE
                reasons.append("No Databento message (data or heartbeat) within the stale window.")
        freshness = ("UNAVAILABLE" if status in (AUTH_ERROR, UNAVAILABLE) else "OFFLINE" if status in (CONNECTING, RECONNECTING) else
                     "STALE" if status == STALE else "DELAYED" if (self.metrics["ingestLagMs"] or 0) > self.cfg.lag_ms else "LIVE")
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
                "sessions": {k: v.view() for k, v in self.sessions.items()},
                "instruments": {root: self.root_status(st) for root, st in self.roots.items()},
                "rolls": list(self.symmap.rolls),
                "metrics": {**self.metrics, "ingestRatePerSec": round(rate, 1), "frames": len(self.frames), "cursor": self.cursor},
                "retention": {"maxTrades": self.cfg.max_trades, "maxFrames": self.cfg.max_frames, "publishMs": self.cfg.publish_ms, "replayHours": self.cfg.replay_hours},
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
