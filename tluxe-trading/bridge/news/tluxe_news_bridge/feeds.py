"""The news backend's feeds: Economic Calendar (Trading Economics), Macro News (Trading Economics News API, opt-in)
and Breaking News (adapter slot - no licensed provider configured -> NOT_CONFIGURED).

Status is derived from what actually happened, never assumed:
  NOT_CONFIGURED (no credential / no provider) · DISABLED · CONNECTING (no successful fetch yet) ·
  LIVE (calendar only: TE streaming connected and messages arriving) · DELAYED (REST refresh working; delay =
  refresh interval) · STALE (no successful refresh within the stale window) · ERROR (auth / entitlement / rate limit /
  network, with a reason).

REST refresh is bounded: the calendar window every TE_CALENDAR_REFRESH_S (default 15 min), recent updates every
TE_UPDATES_REFRESH_S (5 min) - every TE_UPDATES_FAST_S (60 s) only while a MEDIUM/HIGH release is within
-15 / +10 minutes and streaming is not delivering. Errors back off (auth / entitlement 30 min, rate limit doubling).
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Callable

from .config import NewsConfig
from .store import CALENDAR_MATERIAL, NEWS_MATERIAL, RecordStore
from .te_normalize import PROVIDER, PROVIDER_NAME, normalize_calendar, normalize_news
from .te_rest import TeError, TeRestClient
from .te_stream import TeStream

log = logging.getLogger("tluxe.news")
HOLD_S = {"AUTH": 1800, "ENTITLEMENT": 1800}
FAST_WINDOW_BEFORE_MS = 15 * 60_000
FAST_WINDOW_AFTER_MS = 10 * 60_000


class FeedState:
    def __init__(self, name: str, provider: str | None, provider_name: str | None, configured: bool, enabled: bool) -> None:
        self.name = name
        self.provider = provider
        self.provider_name = provider_name
        self.configured = configured
        self.enabled = enabled
        self.last_success_ms: int | None = None
        self.last_data_ms: int | None = None
        self.last_attempt_ms: int | None = None
        self.error: dict | None = None
        self.next_due_ms = 0
        self.fail_streak = 0


class NewsService:
    def __init__(self, cfg: NewsConfig, rest: TeRestClient | None = None, stream: TeStream | None = None,
                 clock: Callable[[], float] = time.time) -> None:
        self.cfg = cfg
        self.clock = clock
        self.rest = rest or TeRestClient(cfg)
        now_ms = lambda: int(self.clock() * 1000)  # noqa: E731
        self.now_ms = now_ms
        self.calendar_store = RecordStore(CALENDAR_MATERIAL, 5000, "scheduledAt", now_ms)
        self.macro_store = RecordStore(NEWS_MATERIAL, 500, "publishedAt", now_ms)
        self.breaking_store = RecordStore(NEWS_MATERIAL, 500, "publishedAt", now_ms)  # stays empty: no provider
        te = cfg.te_configured
        name = PROVIDER_NAME + (" (guest demo key - sample countries only)" if cfg.te_demo else "")
        self.calendar = FeedState("calendar", PROVIDER, name, te, cfg.calendar_enabled)
        self.macro = FeedState("macro", PROVIDER, name, te, cfg.news_enabled)
        self.breaking = FeedState("breaking", cfg.breaking_provider or None, None, False, False)
        self.updates_next_ms = 0
        self.stream = stream if stream is not None else TeStream(cfg, self.ingest_calendar, clock=clock)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="news-scheduler", daemon=True)
        self.lock = threading.RLock()

    # ------------------------------------------------------------------ ingest
    def ingest_calendar(self, records: list) -> int:
        now = self.now_ms()
        n = 0
        for r in records:
            ev = normalize_calendar(r, now)
            if ev is not None:
                self.calendar_store.upsert(ev)
                n += 1
        if n:
            self.calendar.last_data_ms = now
        return n

    def ingest_news(self, records: list, feed: str = "macro") -> int:
        now = self.now_ms()
        store, state = (self.macro_store, self.macro) if feed == "macro" else (self.breaking_store, self.breaking)
        n = 0
        for r in records:
            h = normalize_news(r, now, feed)
            if h is not None:
                store.upsert(h)
                n += 1
        if n:
            state.last_data_ms = now
        return n

    # ------------------------------------------------------------------ scheduling
    def _fail(self, st: FeedState, err: TeError) -> None:
        now = self.now_ms()
        st.error = {"code": err.code, "message": err.message, "atMs": now}
        st.fail_streak += 1
        hold = HOLD_S.get(err.code) or min(1800, 60 * 2 ** min(st.fail_streak - 1, 5))
        st.next_due_ms = now + hold * 1000
        log.warning("%s feed: %s (%s) - next attempt in %d s", st.name, err.code, err.message, hold)

    def _ok(self, st: FeedState) -> None:
        st.last_success_ms = self.now_ms()
        st.error = None
        st.fail_streak = 0

    def _fast_window(self, now: int) -> bool:
        for e in self.calendar_store.all():
            if e.get("importance") in ("HIGH", "MEDIUM") and e.get("actual") is None and -FAST_WINDOW_AFTER_MS <= e["scheduledAt"] - now <= FAST_WINDOW_BEFORE_MS:
                return True
        return False

    def streaming_live(self) -> bool:
        s = self.stream
        return s.state == "CONNECTED" and s.last_message_ms is not None and self.now_ms() - s.last_message_ms < 3 * 60_000

    def updates_interval_s(self) -> int:
        if self.streaming_live():
            return max(self.cfg.updates_refresh_s, 900)  # reconciliation only
        return self.cfg.updates_fast_s if self._fast_window(self.now_ms()) else self.cfg.updates_refresh_s

    def tick(self) -> None:
        """One scheduling step (the loop calls it every second; tests call it directly)."""
        now = self.now_ms()
        c = self.calendar
        if c.configured and c.enabled:
            if now >= c.next_due_ms:
                c.last_attempt_ms = now
                today = datetime.fromtimestamp(now / 1000, tz=timezone.utc).date()
                d1 = (today - timedelta(days=self.cfg.days_back)).isoformat()
                d2 = (today + timedelta(days=self.cfg.days_ahead)).isoformat()
                try:
                    self.ingest_calendar(self.rest.calendar_window(d1, d2))
                    self._ok(c)
                    c.next_due_ms = now + self.cfg.calendar_refresh_s * 1000
                    self.updates_next_ms = now + self.updates_interval_s() * 1000
                except TeError as e:
                    self._fail(c, e)
            elif c.last_success_ms is not None and now >= self.updates_next_ms and c.error is None:
                try:
                    self.ingest_calendar(self.rest.calendar_updates())
                    self._ok(c)
                except TeError as e:
                    self._fail(c, e)
                self.updates_next_ms = now + self.updates_interval_s() * 1000
        m = self.macro
        if m.configured and m.enabled and now >= m.next_due_ms:
            m.last_attempt_ms = now
            try:
                self.ingest_news(self.rest.news(), "macro")
                self._ok(m)
                m.next_due_ms = now + self.cfg.news_refresh_s * 1000
            except TeError as e:
                self._fail(m, e)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:  # pragma: no cover - never kill the scheduler
                log.exception("news scheduler error")
            self._stop.wait(1.0)

    def start(self) -> None:
        if self.calendar.configured and self.calendar.enabled and self.stream.state != "DISABLED":
            self.stream.start()
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self.stream.stop()

    # ------------------------------------------------------------------ status
    def _view(self, st: FeedState, refresh_s: int, streaming: bool = False) -> dict:
        now = self.now_ms()
        stale_ms = (3 * refresh_s + 120) * 1000
        live = streaming and self.streaming_live()
        if not st.configured:
            status, detail = "NOT_CONFIGURED", ("No licensed breaking-news provider is configured." if st.name == "breaking" else "TRADING_ECONOMICS_API_KEY is not set on the news backend.")
        elif not st.enabled:
            status, detail = "DISABLED", f"{st.name} feed disabled in bridge/news/.env."
        elif st.error and (st.last_success_ms is None or now - st.last_success_ms > stale_ms or st.error["code"] in HOLD_S):
            status, detail = "ERROR", st.error["message"]
        elif st.last_success_ms is None and not live:
            status, detail = "CONNECTING", "Waiting for the first successful refresh."
        elif not live and now - (st.last_success_ms or 0) > stale_ms:
            status, detail = "STALE", f"No successful refresh for {round((now - (st.last_success_ms or 0)) / 1000)} s."
        elif live:
            status, detail = "LIVE", "Trading Economics streaming connected."
        else:
            status, detail = "DELAYED", f"REST refresh (every {refresh_s} s)."
        return {
            "feed": st.name,
            "provider": st.provider,
            "providerName": st.provider_name,
            "configured": st.configured,
            "enabled": st.enabled,
            "status": status,
            "detail": detail,
            "latency": "REALTIME" if status == "LIVE" else "DELAYED" if status in ("DELAYED", "STALE") else "UNKNOWN",
            "delaySec": None if status == "LIVE" else refresh_s,
            "staleAfterMs": stale_ms,
            "lastSuccessMs": st.last_success_ms,
            "lastDataMs": st.last_data_ms,
            "lastAttemptMs": st.last_attempt_ms,
            "error": st.error,
        }

    def health(self) -> dict:
        s = self.stream
        cal = self._view(self.calendar, self.updates_interval_s(), streaming=True)
        cal["streaming"] = {"state": s.state, "detail": s.detail, "lastMessageMs": s.last_message_ms, "messages": s.messages, "records": s.records}
        cal["events"] = len(self.calendar_store)
        cal["counts"] = dict(self.calendar_store.counts)
        macro = self._view(self.macro, self.cfg.news_refresh_s)
        macro["items"] = len(self.macro_store)
        breaking = self._view(self.breaking, self.cfg.news_refresh_s)
        breaking["items"] = 0
        return {"feeds": {"calendar": cal, "macro": macro, "breaking": breaking}, "restRequests": self.rest.requests, "demoKey": self.cfg.te_demo}
