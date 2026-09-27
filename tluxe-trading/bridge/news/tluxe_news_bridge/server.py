"""Local authenticated HTTP API between the TLUXE browser app and the news backend (read-only).

  GET /v1/health                              feed status (provider, status, freshness, streaming entitlement)
  GET /v1/calendar?since=SEQ&limit=N          normalized calendar events changed after SEQ (new + revised)
  GET /v1/headlines?feed=macro|breaking&since=SEQ&limit=N

Bearer TLUXE_NEWS_TOKEN on every request; exact browser-origin allowlist (never "*"); 127.0.0.1 only. Provider
credentials are never accepted, echoed or returned.
"""
from __future__ import annotations

import errno
import hmac
import json
import logging
import os
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import __version__
from .config import NewsConfig
from .feeds import NewsService
from .redact import Redactor

log = logging.getLogger("tluxe.news.http")


def make_handler(cfg: NewsConfig, svc: NewsService, started_ms: int):
    token = cfg.token.reveal().encode()
    redact = Redactor(cfg.te_key.reveal(), cfg.token.reveal())
    rejected: set[str] = set()

    class Handler(BaseHTTPRequestHandler):
        server_version = "TLUXE-News/" + __version__
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # never logs headers (token)
            log.debug("%s %s", self.address_string(), redact(fmt % args))

        def _origin_ok(self) -> bool:
            origin = self.headers.get("Origin")
            if origin is None or origin in cfg.allowed_origins:
                return True
            if origin not in rejected:
                rejected.add(origin)
                log.warning("Rejected browser origin %s - add it to TLUXE_NEWS_ALLOWED_ORIGINS if it is a TLUXE preview", redact(origin))
            return False

        def _cors(self) -> None:
            origin = self.headers.get("Origin")
            if origin and origin in cfg.allowed_origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Headers", "Authorization")
                self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
                self.send_header("Access-Control-Max-Age", "600")
                if self.headers.get("Access-Control-Request-Private-Network") == "true":
                    self.send_header("Access-Control-Allow-Private-Network", "true")

        def _json(self, status: int, body: dict) -> None:
            data = redact(json.dumps(body, separators=(",", ":"), ensure_ascii=False)).encode()
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _error(self, status: int, code: str, message: str) -> None:
            self._json(status, {"error": {"code": code, "message": message}})

        def do_OPTIONS(self):  # noqa: N802
            if not self._origin_ok():
                return self._error(403, "ORIGIN_NOT_ALLOWED", "This browser origin is not allowed.")
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self):  # noqa: N802 - read-only API
            self._error(405, "METHOD_NOT_ALLOWED", "The news backend is read-only.")

        def do_GET(self):  # noqa: N802
            if self.path == "/healthz":  # container liveness probe: no auth, no details
                return self._json(200, {"ok": True})
            if not self._origin_ok():
                return self._error(403, "ORIGIN_NOT_ALLOWED", "This browser origin is not allowed.")
            auth = self.headers.get("Authorization", "")
            if not hmac.compare_digest(auth[7:].encode() if auth.startswith("Bearer ") else b"", token):
                return self._error(401, "UNAUTHORIZED", "Missing or invalid news backend token.")
            url = urlparse(self.path)
            q = parse_qs(url.query)
            path = url.path.rstrip("/")
            try:
                since = int((q.get("since") or ["0"])[0])
                limit = max(1, min(2000, int((q.get("limit") or ["500"])[0])))
            except ValueError:
                return self._error(400, "BAD_REQUEST", "since / limit must be integers.")
            try:
                if path == "/v1/health":
                    return self._json(200, {"service": "tluxe-news", "version": __version__, "startedAtMs": started_ms, "timeMs": svc.now_ms(), **svc.health()})
                if path == "/v1/calendar":
                    items, seq = svc.calendar_store.since(since, limit)
                    return self._json(200, {"feed": "calendar", "seq": seq, "reset": since > seq, "events": items})
                if path == "/v1/headlines":
                    feed = (q.get("feed") or ["macro"])[0]
                    if feed not in ("macro", "breaking"):
                        return self._error(400, "BAD_REQUEST", "feed must be macro or breaking.")
                    store = svc.macro_store if feed == "macro" else svc.breaking_store
                    items, seq = store.since(since, limit)
                    return self._json(200, {"feed": feed, "seq": seq, "reset": since > seq, "headlines": items})
                return self._error(404, "NOT_FOUND", "Unknown endpoint.")
            except Exception:  # pragma: no cover - defensive; details only in the (redacted) log
                log.exception("request failed")
                return self._error(500, "ERROR", "Internal news backend error.")

    return Handler


class ExclusiveHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self) -> None:
        excl = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        if os.name == "nt" and excl is not None:
            self.socket.setsockopt(socket.SOL_SOCKET, excl, 1)
        super().server_bind()


class DualStackHTTPServer(ExclusiveHTTPServer):
    """IPv6 listener that also accepts IPv4 (Railway private networking is IPv6; container health checks use 127.0.0.1)."""

    address_family = socket.AF_INET6

    def server_bind(self) -> None:
        if hasattr(socket, "IPV6_V6ONLY"):
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def serve(cfg: NewsConfig, svc: NewsService, started_ms: int = 0) -> ThreadingHTTPServer:
    if ":" in cfg.host:
        try:
            return DualStackHTTPServer((cfg.host, cfg.port), make_handler(cfg, svc, started_ms))
        except OSError as exc:
            if exc.errno != errno.EAFNOSUPPORT:
                raise
            logging.getLogger(__name__).warning("IPv6 not available on this host - listening on 0.0.0.0 instead")
            return ExclusiveHTTPServer(("0.0.0.0", cfg.port), make_handler(cfg, svc, started_ms))
    return ExclusiveHTTPServer((cfg.host, cfg.port), make_handler(cfg, svc, started_ms))
