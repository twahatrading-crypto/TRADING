"""Trading Economics streaming (websocket) for live calendar releases - ONLY if the plan includes it.

Entitlement is DETECTED, never assumed:
  * handshake rejected (HTTP 401 / 403) or an auth / subscription error message / close reason -> NOT_ENTITLED
    (no retry loop: re-checked after NOT_ENTITLED_RETRY_S; REST keeps the calendar current meanwhile);
  * `websockets` not installed -> UNAVAILABLE (REST only);
  * proxy / firewall / network refusal -> UNREACHABLE (retried with back-off; NOT an entitlement verdict);
  * socket open and messages arriving -> CONNECTED (the calendar feed may then be reported LIVE).
Every message (data or keep-alive) refreshes `last_message_ms`. Reconnects back off 5 s -> 5 min.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import urllib.parse
from typing import Callable

from .config import NewsConfig
from .redact import Redactor

log = logging.getLogger("tluxe.news.stream")
NOT_ENTITLED_RETRY_S = 6 * 3600
RECV_TIMEOUT_S = 90
_DENIED = ("unauthor", "forbidden", "not allowed", "permission", "subscription", "invalid key", "invalid client", "not authorized", "denied")


def _default_connect(url: str):
    from websockets.sync.client import connect

    return connect(url, open_timeout=15, close_timeout=5, max_size=4_000_000)


class TeStream(threading.Thread):
    def __init__(self, cfg: NewsConfig, on_records: Callable[[list], None], connect: Callable | None = None,
                 clock: Callable[[], float] = time.time, sleep: Callable[[float], None] | None = None) -> None:
        super().__init__(name="te-stream", daemon=True)
        self.cfg = cfg
        self.on_records = on_records
        self.redact = Redactor(cfg.te_key.reveal(), cfg.token.reveal())
        self._connect = connect
        self.clock = clock
        self.stop_evt = threading.Event()
        self._sleep = sleep or (lambda s: self.stop_evt.wait(s))
        self.state = "DISABLED" if cfg.streaming == "off" or not cfg.te_configured else "CONNECTING"
        self.detail: str | None = None
        self.last_message_ms: int | None = None
        self.messages = 0
        self.records = 0
        self.connects = 0
        self._ws = None

    def _url(self) -> str:
        return f"{self.cfg.stream_url}?{urllib.parse.urlencode({'client': self.cfg.te_key.reveal()})}"

    def stop(self) -> None:
        self.stop_evt.set()
        ws = self._ws
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass

    def _denied(self, text: str) -> bool:
        low = text.lower()
        return any(d in low for d in _DENIED)

    def _not_entitled(self, why: str) -> None:
        self.state = "NOT_ENTITLED"
        self.detail = self.redact(why)[:200]
        log.warning("Trading Economics streaming not available for this credential (%s) - using REST refresh.", self.detail)

    def handle(self, raw: str | bytes) -> None:
        self.messages += 1
        self.last_message_ms = int(self.clock() * 1000)
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            return
        items = data if isinstance(data, list) else [data]
        records = []
        for it in items:
            if not isinstance(it, dict):
                continue
            topic = str(it.get("topic") or "").lower()
            if topic in ("keepalive", "heartbeat", "ping", "subscribed", "subscribe"):
                continue
            err = it.get("error") or it.get("Error") or (it.get("message") if topic == "error" else None)
            if err and self._denied(str(err)):
                raise PermissionError(str(err))
            if any(str(k).lower() == "calendarid" for k in it):
                records.append(it)
        if records:
            self.records += len(records)
            self.on_records(records)

    def run(self) -> None:  # noqa: C901 - explicit state machine
        if self.state == "DISABLED":
            return
        try:
            connect = self._connect or _default_connect
            if self._connect is None:
                import websockets  # noqa: F401 - availability check
        except ImportError:
            self.state, self.detail = "UNAVAILABLE", "Python package 'websockets' not installed - REST refresh only."
            return
        backoff = 5.0
        while not self.stop_evt.is_set():
            self.state = "CONNECTING" if self.connects == 0 else "RECONNECTING"
            started = self.clock()
            try:
                ws = connect(self._url())
                self._ws = ws
                self.connects += 1
                with ws:
                    ws.send(json.dumps({"topic": "subscribe", "to": "calendar"}))
                    self.state, self.detail = "CONNECTED", None
                    while not self.stop_evt.is_set():
                        try:
                            msg = ws.recv(timeout=RECV_TIMEOUT_S)
                        except TimeoutError:
                            self.detail = f"No streaming message for {RECV_TIMEOUT_S} s - reconnecting."
                            break
                        self.handle(msg)
            except PermissionError as exc:
                self._not_entitled(str(exc))
            except Exception as exc:  # noqa: BLE001 - classified, redacted
                status = getattr(getattr(exc, "response", None), "status_code", None)
                reason = str(getattr(exc, "rcvd", None) and getattr(exc.rcvd, "reason", "") or exc)
                # A proxy / firewall refusing the tunnel says nothing about the Trading Economics plan: network problem.
                via_proxy = "proxy" in type(exc).__name__.lower() or "proxy" in reason.lower()
                if not via_proxy and (status in (401, 403) or self._denied(reason)):
                    self._not_entitled(f"HTTP {status} from the Trading Economics stream" if status else reason)
                elif not self.stop_evt.is_set():
                    self.state = "UNREACHABLE"
                    self.detail = self.redact(f"Streaming endpoint not reachable ({type(exc).__name__}: {exc})")[:200]
            finally:
                self._ws = None
            if self.stop_evt.is_set():
                break
            if self.state == "NOT_ENTITLED":
                self._sleep(NOT_ENTITLED_RETRY_S)
                continue
            if self.clock() - started > 120:
                backoff = 5.0
            self._sleep(backoff)
            backoff = min(300.0, backoff * 2)
