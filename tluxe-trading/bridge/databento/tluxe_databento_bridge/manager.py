"""The ONE Databento connection architecture of the bridge.

  tape session : Live(GLBX.MDP3)  subscribe(trades, start=S) + (ohlcv-1m, start=S) -> trades, candles (GC, SI)
  book session : Live(GLBX.MDP3)  subscribe(mbo, snapshot=True)                -> order books (GC, SI)
                 ONLY with TLUXE_DB_PLAN=mbo. On CME Globex MDP 3.0 Standard (default) no book session exists:
                 mbo and mbp-10 are never requested.

Both sessions are owned by this manager (never by a browser tab / React component). The SDK callback only
enqueues records; a single worker applies them to the hub in arrival order, so the Databento reader is never
blocked by processing and the backlog (queue depth) is measurable.

Recovery (Databento documented behaviour):
  * MBO: a new session with snapshot=True rebuilds the book from a fresh snapshot (SYNCING until complete).
    Triggered on disconnect, F_MAYBE_BAD_BOOK, out-of-order sequence, inconsistent records and contract rolls.
  * trades / ohlcv: the new session uses intraday replay (`start`) from shortly before the last processed trade;
    the tape drops the overlap exactly (de-dup keys). An outage longer than the replay window is flagged as a GAP.
  * backoff 1 s -> 60 s with jitter; > STORM_MAX reconnects in STORM_WINDOW_S -> reconnect storm hold-off.
  * authentication failure -> AUTH_ERROR, retried only every AUTH_RETRY_S (never a tight loop).
  * replay start outside Databento's intraday window ("Invalid start time. Must be <T> or later"): the next start
    is clamped to the gateway's boundary (+ pad) and the session reconnects ONCE; a further rejection switches the
    tape session to live-only (no `start`, history gap flagged). Never counted as a disconnect storm, never a loop.
  * entitlement ("Not authorized for <schema> schema") -> that schema is dropped from the subscription (NOT_ENTITLED);
    a session with no entitled schema left stops. Never an AUTH_ERROR, never a reconnect loop.
"""
from __future__ import annotations

import logging
import queue
import random
import threading
import time
from collections import deque
from typing import Callable

from .config import DATASET, BridgeConfig, Secret
from .entitlement import AUTH, ENTITLEMENT, START
from .hub import Hub

log = logging.getLogger("tluxe.databento")

AUTH_RETRY_S = 300
STORM_WINDOW_S = 300
STORM_MAX = 8
STORM_HOLD_S = 120
RESYNC_MIN_INTERVAL_S = 15
MAX_START_CORRECTIONS = 1  # reconnects with a corrected start before falling back to live-only
HARD_QUEUE_LIMIT = 2_000_000
BATCH = 1000
BATCH_MAX_S = 0.02  # never hold the hub lock longer than this: frames keep flowing under load


def default_client_factory(api_key: Secret, heartbeat_s: int):
    """The official Databento Live client (reconnects are managed by this bridge, explicitly)."""
    import databento as db

    return db.Live(key=api_key.reveal(), heartbeat_interval_s=heartbeat_s, reconnect_policy="none")


class Ingest:
    """Unbounded FIFO between the SDK reader thread and the worker. Depth is measured and reported; a backlog
    beyond HARD_QUEUE_LIMIT is resolved by a book resync (queued book records are then obsolete), never by
    silently dropping records that the book still needs."""

    def __init__(self, hub: Hub) -> None:
        self.hub = hub
        self.q: queue.SimpleQueue = queue.SimpleQueue()
        self.stop_evt = threading.Event()
        self.dropped_for_resync = 0
        self.thread = threading.Thread(target=self._run, name="databento-ingest", daemon=True)

    def put(self, session: str, record) -> None:
        self.q.put(("rec", session, record, int(time.time() * 1000)))

    def control(self, session: str, event: str, payload=None) -> None:
        self.q.put(("ctl", session, event, payload))

    def qsize(self) -> int:
        return self.q.qsize()

    def wait_applied(self, timeout: float = 2.0) -> None:
        """Wait until the worker has applied everything queued so far (errors / entitlement are then known to the hub).
        No-op when the worker thread is not running (tests drain manually)."""
        if not self.thread.is_alive():
            return
        done = threading.Event()
        self.q.put(("mark", None, done, None))
        done.wait(timeout)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_evt.set()
        self.q.put(("stop", None, None, None))

    def drain_once(self, block: bool = True) -> int:
        """Process up to BATCH queued items (also used by tests for deterministic stepping)."""
        n = 0
        try:
            item = self.q.get(block=block, timeout=0.5 if block else None)
        except queue.Empty:
            return 0
        deadline = time.perf_counter() + BATCH_MAX_S
        with self.hub.lock:
            while True:
                n += 1
                self._apply(item)
                if n >= BATCH or (n % 64 == 0 and time.perf_counter() > deadline):
                    break
                try:
                    item = self.q.get_nowait()
                except queue.Empty:
                    break
            depth = self.q.qsize()
            self.hub.set_queue_depth(depth)
            if depth > HARD_QUEUE_LIMIT:
                self._shed_book_backlog()
        time.sleep(0)  # yield so the publisher / HTTP threads get the lock between batches
        return n

    def _shed_book_backlog(self) -> None:
        keep = []
        while True:
            try:
                item = self.q.get_nowait()
            except queue.Empty:
                break
            if item[0] == "rec" and item[1] == "book":
                self.dropped_for_resync += 1
            else:
                keep.append(item)
        for item in keep:
            self.q.put(item)
        self.hub.metrics["droppedForResync"] = self.dropped_for_resync
        self.hub.request_resync("book", "consumer backlog too large - book rebuilt from a fresh snapshot")
        self.hub.on_session_closed("book", reconnecting=True)

    def _apply(self, item) -> None:
        kind, session, a, b = item
        if kind == "mark":
            a.set()
        elif kind == "rec":
            self.hub.on_record(session, a, b)
        elif kind == "ctl":
            if a == "connecting":
                s = self.hub.sessions[session]
                if s.state not in ("AUTH_ERROR", "UNAVAILABLE", "DISABLED"):
                    s.state = "RECONNECTING" if s.ever_connected else "CONNECTING"
            elif a == "connected":
                self.hub.on_session_connected(session)
            elif a == "error":
                self.hub.on_error(session, str(b), fatal=True)
            elif a == "closed":
                s = self.hub.sessions[session]
                if b == "resync":
                    s.resyncs += 1
                elif b == "reconnect":
                    s.reconnects += 1
                self.hub.on_session_closed(session, reconnecting=b != "stop")
            elif a == "storm":
                self.hub.sessions[session].storm = bool(b)
            elif a == "gap":
                self.hub.note_tape_gap(str(b))

    def _run(self) -> None:
        while not self.stop_evt.is_set():
            try:
                self.drain_once(block=True)
            except Exception:  # pragma: no cover - defensive: never kill the worker
                log.exception("ingest worker error")


class SessionRunner(threading.Thread):
    def __init__(self, name: str, cfg: BridgeConfig, hub: Hub, ingest: Ingest, factory: Callable, sleep: Callable[[float], None] | None = None, rand: Callable[[], float] = random.random) -> None:
        super().__init__(name=f"databento-{name}", daemon=True)
        self.session = name
        self.cfg = cfg
        self.hub = hub
        self.ingest = ingest
        self.factory = factory
        self.stop_evt = threading.Event()
        self._sleep = sleep or (lambda s: self.stop_evt.wait(s))
        self.rand = rand
        self.client = None
        self.attempts = 0
        self.recent: deque = deque()
        self.last_resync = 0.0

    def subscriptions(self) -> list[dict]:
        groups: dict[str, list[str]] = {}
        for st in self.hub.roots.values():
            groups.setdefault(st.stype, []).append(st.symbol)
        schemas = self.hub.requested_schemas(self.session)
        subs = []
        for stype, symbols in groups.items():
            if self.session == "book":
                subs += [{"schema": sc, "symbols": symbols, "stype_in": stype, "snapshot": True} for sc in schemas]
            elif schemas:
                start = self.hub.tape_replay_start_ns() if self.cfg.replay_hours > 0 else None
                subs += [{"schema": sc, "symbols": symbols, "stype_in": stype, "start": start} for sc in schemas]
        return subs

    def stop(self) -> None:
        self.stop_evt.set()
        c = self.client
        if c is not None:
            try:
                c.terminate()
            except Exception:
                pass

    def _connect_once(self) -> str:
        """One session lifetime. Returns why it ended: 'stop' | 'resync' | 'reconnect' | 'auth' | 'entitlement'."""
        self.ingest.control(self.session, "connecting")
        errbox: list[BaseException] = []
        try:
            client = self.factory(self.cfg.api_key, self.cfg.heartbeat_s)
            client.add_callback(lambda rec: self.ingest.put(self.session, rec), lambda exc: errbox.append(exc))
            for sub in self.subscriptions():
                kwargs = {k: v for k, v in sub.items() if v is not None and k not in ("schema", "symbols", "stype_in")}
                client.subscribe(dataset=DATASET, schema=sub["schema"], symbols=sub["symbols"], stype_in=sub["stype_in"], **kwargs)
            client.start()
        except Exception as exc:
            # Applied synchronously (thread-safe) so the next attempt already knows an entitlement / auth outcome.
            kind = self.hub.on_error(self.session, str(exc), fatal=True)
            self.hub.take_start_error()
            return "auth" if kind == AUTH else "entitlement" if kind == ENTITLEMENT else "start" if kind == START else "reconnect"
        self.client = client
        self.ingest.control(self.session, "connected")
        done = threading.Event()

        def waiter() -> None:
            try:
                client.block_for_close()
            except BaseException as exc:  # noqa: BLE001 - reported below, redacted
                errbox.append(exc)
            finally:
                done.set()

        threading.Thread(target=waiter, name=f"databento-{self.session}-wait", daemon=True).start()
        why = "reconnect"
        while not done.wait(0.25):
            if self.stop_evt.is_set():
                why = "stop"
                break
            reason = self.hub.take_resync(self.session)
            if reason:
                if time.monotonic() - self.last_resync < RESYNC_MIN_INTERVAL_S:
                    self.hub.request_resync(self.session, reason)  # keep it pending (rate limited)
                    continue
                self.last_resync = time.monotonic()
                log.info("%s session resync: %s", self.session, self.hub.redact(reason))
                why = "resync"
                break
        if not done.is_set():
            try:
                client.terminate()
            except Exception:
                pass
            done.wait(5)
        self.client = None
        for exc in errbox:
            kind = self.hub.on_error(self.session, str(exc), fatal=True)
            if kind == AUTH:
                why = "auth"
            elif kind == ENTITLEMENT and why != "stop":
                why = "entitlement"
        if why != "stop" and self.hub.take_start_error():
            why = "start"  # also covers an in-stream ErrorMsg (resync requested by the hub)
        return why

    def run(self) -> None:
        backoff = 1.0
        start_corrections = 0
        while not self.stop_evt.is_set():
            self.ingest.wait_applied()
            if not self.hub.requested_schemas(self.session):
                # Nothing entitled / nothing in the plan for this session: it stays closed (no retry loop).
                log.warning("%s session: no entitled schema to subscribe - session stopped", self.session)
                break
            started = time.monotonic()
            why = self._connect_once()
            self.ingest.control(self.session, "closed", "stop" if why == "stop" else "resync" if why == "resync" else "reconnect")
            if why == "stop" or self.stop_evt.is_set():
                break
            if why == "auth":
                self._sleep(AUTH_RETRY_S)
                continue
            if why == "start":
                start_corrections += 1
                if start_corrections > MAX_START_CORRECTIONS:
                    msg = "Databento rejected the intraday replay start again - live-only (history before connect unavailable, gap flagged)"
                    log.warning("%s session: %s", self.session, msg)
                    self.hub.disable_replay(msg)
                else:
                    log.warning("%s session: replay start rejected - reconnecting once with a start inside the allowed window", self.session)
                self._sleep(1.0)
                continue
            start_corrections = 0
            if why in ("resync", "entitlement"):
                # entitlement: the rejected schema is now excluded; reconnect once with the remaining schemas.
                self._sleep(0.2 if why == "resync" else 1.0)
                continue
            if time.monotonic() - started > 60:
                backoff = 1.0
            now = time.monotonic()
            self.recent.append(now)
            while self.recent and now - self.recent[0] > STORM_WINDOW_S:
                self.recent.popleft()
            if len(self.recent) > STORM_MAX:
                self.ingest.control(self.session, "storm", True)
                log.warning("%s session: reconnect storm (%d in %ds) - holding off %ds", self.session, len(self.recent), STORM_WINDOW_S, STORM_HOLD_S)
                self._sleep(STORM_HOLD_S)
                self.recent.clear()
                self.ingest.control(self.session, "storm", False)
                continue
            self._sleep(backoff * (0.5 + self.rand()))
            backoff = min(60.0, backoff * 2)


class Manager:
    def __init__(self, cfg: BridgeConfig, factory: Callable | None = None, hub: Hub | None = None) -> None:
        self.cfg = cfg
        self.hub = hub or Hub(cfg)
        self.ingest = Ingest(self.hub)
        factory = factory or default_client_factory
        # Standard plan: ONE Databento session (trades + ohlcv-1m). The MBO book session exists only on a MBO plan.
        names = ["book", "tape"] if cfg.depth_plan else ["tape"]
        self.runners = [SessionRunner(n, cfg, self.hub, self.ingest, factory) for n in names]
        self._stop = threading.Event()
        self._pub = threading.Thread(target=self._publish_loop, name="databento-publish", daemon=True)

    def _publish_loop(self) -> None:
        while not self._stop.wait(self.cfg.publish_ms / 1000):
            self.hub.set_queue_depth(self.ingest.qsize())
            self.hub.publish()

    def start(self) -> None:
        self.ingest.start()
        for r in self.runners:
            r.start()
        self._pub.start()

    def stop(self) -> None:
        self._stop.set()
        for r in self.runners:
            r.stop()
        self.ingest.stop()
