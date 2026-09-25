"""Local authenticated HTTP API over the MT5 terminal (read-only)."""
from __future__ import annotations

import hmac
import json
import logging
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from . import __version__
from .config import BridgeConfig
from .terminal import BridgeError, Terminal

log = logging.getLogger("tluxe.bridge")


def make_handler(cfg: BridgeConfig, term: Terminal, started_at: float):
    token = cfg.token.encode()
    rejected: set[str] = set()

    class Handler(BaseHTTPRequestHandler):
        server_version = "TLUXE-MT5-Bridge/" + __version__

        def log_message(self, fmt, *args):  # route through logging; never logs headers
            log.info("%s %s", self.address_string(), fmt % args)

        # ---------------------------------------------------------------- CORS
        def _cors(self) -> None:
            origin = self.headers.get("Origin")
            if origin and origin not in cfg.allowed_origins and origin not in rejected:
                rejected.add(origin)
                log.warning("Rejected browser origin %s - add it to TLUXE_BRIDGE_ALLOWED_ORIGINS in .env and restart", origin)
            if origin and origin in cfg.allowed_origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Headers", "Authorization")
                self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
                if self.headers.get("Access-Control-Request-Private-Network") == "true":
                    self.send_header("Access-Control-Allow-Private-Network", "true")

        def _json(self, status: int, body: dict) -> None:
            data = json.dumps(body, separators=(",", ":")).encode()
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
            if not self._authorised():
                return self._json(401, {"error": {"code": "UNAUTHORIZED", "message": "Missing or invalid bridge token"}})
            url = urlparse(self.path)
            q = parse_qs(url.query)
            parts = [unquote(p) for p in url.path.strip("/").split("/")]
            try:
                if parts == ["v1", "health"]:
                    body = term.health()
                    body["bridge"] = {"version": __version__, "startedAtMs": int(started_at * 1000),
                                      "heartbeatAtMs": int(time.time() * 1000)}
                    return self._json(200, body)
                if parts == ["v1", "symbols"]:
                    syms = term.symbols()
                    return self._json(200, {"count": len(syms), "symbols": syms})
                if len(parts) == 3 and parts[:2] == ["v1", "symbol"]:
                    return self._json(200, term.symbol(parts[2]))
                if len(parts) == 3 and parts[:2] == ["v1", "quote"]:
                    return self._json(200, term.quote(parts[2]))
                if len(parts) == 3 and parts[:2] == ["v1", "rates"]:
                    tf = (q.get("timeframe") or ["H1"])[0]
                    count = int((q.get("count") or ["500"])[0])
                    return self._json(200, term.rates(parts[2], tf, count))
                return self._json(404, {"error": {"code": "NOT_FOUND", "message": "Unknown endpoint"}})
            except BridgeError as exc:
                return self._json(exc.status, {"error": {"code": exc.code, "message": exc.message}})
            except ValueError as exc:
                return self._json(400, {"error": {"code": "BAD_REQUEST", "message": str(exc)}})
            except Exception:  # pragma: no cover - defensive
                log.exception("Unhandled error")
                return self._json(500, {"error": {"code": "ERROR", "message": "Internal bridge error"}})

    return Handler


class ExclusiveHTTPServer(ThreadingHTTPServer):
    """Never shares its port. ThreadingHTTPServer inherits allow_reuse_address = 1, which on Windows lets a
    second (orphaned or new) bridge bind the same port and split requests between them. Here a second
    bind fails loudly instead."""

    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self) -> None:
        excl = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        if os.name == "nt" and excl is not None:
            self.socket.setsockopt(socket.SOL_SOCKET, excl, 1)
        super().server_bind()


def serve(cfg: BridgeConfig, term: Terminal) -> ThreadingHTTPServer:
    started = time.time()
    httpd = ExclusiveHTTPServer((cfg.host, cfg.port), make_handler(cfg, term, started))

    def watchdog() -> None:
        while True:
            term.ensure()
            time.sleep(3)

    threading.Thread(target=watchdog, daemon=True, name="mt5-watchdog").start()
    return httpd
