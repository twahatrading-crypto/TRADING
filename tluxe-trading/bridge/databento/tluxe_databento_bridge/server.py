"""Local authenticated HTTP API (read-only market data) between the bridge and the TLUXE browser app.

Endpoints (all GET, Bearer token = TLUXE_DB_BRIDGE_TOKEN, CORS allowlist; the Databento API key is never
accepted, echoed or returned):
  /v1/health                          provider / session / per-instrument status, diagnostics, metrics
  /v1/feed?cursor=N&roots=GC          batched frames after cursor (reset=true when the client fell behind)
  /v1/book/{GC|SI}                    current aggregated price levels of the reconstructed MBO book (only when VALID)
  /v1/trades/{GC|SI}?after=I&limit=L  retained trades after transport index I (recovery for slow clients)
  /v1/candles/{GC|SI}?timeframe=M1    bars of the CURRENT contract (ohlcv-1m + forming bar from trades)
"""
from __future__ import annotations

import errno
import hmac
import json
import logging
import os
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from . import __version__
from .candles import TF_SECONDS
from .config import ROOTS, BridgeConfig
from .hub import Hub

log = logging.getLogger("tluxe.databento.http")


def make_handler(cfg: BridgeConfig, hub: Hub, started_ms: int):
    token = cfg.token.reveal().encode()
    rejected: set[str] = set()

    class Handler(BaseHTTPRequestHandler):
        server_version = "TLUXE-Databento-Bridge/" + __version__

        def log_message(self, fmt, *args):  # never logs headers (token)
            log.debug("%s %s", self.address_string(), hub.redact(fmt % args))

        def _cors(self) -> None:
            origin = self.headers.get("Origin")
            if origin and origin not in cfg.allowed_origins and origin not in rejected:
                rejected.add(origin)
                log.warning("Rejected browser origin %s - add it to TLUXE_DB_BRIDGE_ALLOWED_ORIGINS", origin)
            if origin and origin in cfg.allowed_origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Headers", "Authorization")
                self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
                if self.headers.get("Access-Control-Request-Private-Network") == "true":
                    self.send_header("Access-Control-Allow-Private-Network", "true")

        def _json(self, status: int, body: dict) -> None:
            data = hub.redact(json.dumps(body, separators=(",", ":"))).encode()
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):  # noqa: N802
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _authorised(self) -> bool:
            auth = self.headers.get("Authorization", "")
            given = auth[7:].encode() if auth.startswith("Bearer ") else b""
            return hmac.compare_digest(given, token)

        def do_GET(self):  # noqa: N802
            if self.path == "/healthz":  # container liveness probe: no auth, no details
                return self._json(200, {"ok": True})
            if not self._authorised():
                return self._json(401, {"error": {"code": "UNAUTHORIZED", "message": "Missing or invalid bridge token"}})
            url = urlparse(self.path)
            q = parse_qs(url.query)
            parts = [unquote(p) for p in url.path.strip("/").split("/")]
            try:
                if parts == ["v1", "health"]:
                    body = hub.health()
                    body["bridge"] = {"version": __version__, "startedAtMs": started_ms, "heartbeatAtMs": hub.now()}
                    return self._json(200, body)
                if parts == ["v1", "feed"]:
                    cursor = int((q.get("cursor") or ["0"])[0])
                    roots = [r for r in (q.get("roots") or [""])[0].split(",") if r in ROOTS] or None
                    return self._json(200, hub.frames_after(cursor, roots))
                if len(parts) == 3 and parts[1] in ("book", "trades", "candles") and parts[0] == "v1":
                    root = parts[2].upper()
                    if root not in ROOTS:
                        return self._json(404, {"error": {"code": "UNKNOWN_INSTRUMENT", "message": "Supported: GC, SI"}})
                    if parts[1] == "book":
                        return self._json(200, hub.book_snapshot(root))
                    if parts[1] == "trades":
                        after = int((q.get("after") or ["0"])[0])
                        limit = max(1, min(50_000, int((q.get("limit") or ["20000"])[0])))
                        return self._json(200, hub.trades_after(root, after, limit))
                    tf = (q.get("timeframe") or ["M1"])[0]
                    if tf not in TF_SECONDS:
                        return self._json(400, {"error": {"code": "BAD_TIMEFRAME", "message": "Unknown timeframe"}})
                    limit = max(1, min(5000, int((q.get("limit") or ["5000"])[0])))
                    return self._json(200, hub.candles(root, tf, limit))
                return self._json(404, {"error": {"code": "NOT_FOUND", "message": "Unknown endpoint"}})
            except ValueError:
                return self._json(400, {"error": {"code": "BAD_REQUEST", "message": "Invalid parameter"}})
            except Exception:  # pragma: no cover - defensive; details only in the (redacted) log
                log.exception("Unhandled error")
                return self._json(500, {"error": {"code": "ERROR", "message": "Internal bridge error"}})

    return Handler


class ExclusiveHTTPServer(ThreadingHTTPServer):
    """Never shares its port (a second bridge on the same port fails loudly)."""

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


def serve(cfg: BridgeConfig, hub: Hub) -> ThreadingHTTPServer:
    if ":" in cfg.host:
        try:
            return DualStackHTTPServer((cfg.host, cfg.port), make_handler(cfg, hub, hub.now()))
        except OSError as exc:
            if exc.errno != errno.EAFNOSUPPORT:
                raise
            logging.getLogger(__name__).warning("IPv6 not available on this host - listening on 0.0.0.0 instead")
            return ExclusiveHTTPServer(("0.0.0.0", cfg.port), make_handler(cfg, hub, hub.now()))
    return ExclusiveHTTPServer((cfg.host, cfg.port), make_handler(cfg, hub, hub.now()))
