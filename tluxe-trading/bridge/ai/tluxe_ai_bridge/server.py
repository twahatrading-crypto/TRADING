"""Local authenticated HTTP API between the TLUXE browser app and OpenAI.

  GET  /api/ai/health   safe status only: provider verification, model name, read-only permissions, limits
  POST /api/ai/chat     {messages:[{role,content}], context?, mode?, requestId?} -> {text, model, ...}

Every request needs the bridge token (Bearer TLUXE_AI_TOKEN). Browser origins must match the allowlist exactly
(no "*"); a request from any other origin is refused. The OpenAI key is never accepted, echoed or returned.
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import __version__
from .config import AiConfig
from .provider import OpenAIProvider, ProviderError
from .validation import MAX_BODY_BYTES, MAX_CONTEXT_BYTES, MAX_MESSAGE_CHARS, MAX_MESSAGES, MAX_TOTAL_CHARS, ValidationError, validate_chat

log = logging.getLogger("tluxe.ai.http")
MAX_CONCURRENT_CHATS = 2

READ_ONLY_PERMISSIONS = {
    "readOnly": True,
    "tools": [],
    "placeTrades": False,
    "modifyOrders": False,
    "controlMt5": False,
    "shellCommands": False,
    "writeFiles": False,
    "filesystem": False,
    "environment": False,
    "changeEngineSettings": False,
}


def make_handler(cfg: AiConfig, provider: OpenAIProvider, started_ms: int):
    token = cfg.token.reveal().encode()
    slots = threading.BoundedSemaphore(MAX_CONCURRENT_CHATS)
    rejected: set[str] = set()

    class Handler(BaseHTTPRequestHandler):
        server_version = "TLUXE-AI/" + __version__
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # never logs headers (token) or bodies
            log.debug("%s %s", self.address_string(), provider.redact(fmt % args))

        def _origin_ok(self) -> bool:
            origin = self.headers.get("Origin")
            if origin is None:
                return True  # non-browser local client (still needs the token)
            if origin in cfg.allowed_origins:
                return True
            if origin not in rejected:
                rejected.add(origin)
                log.warning("Rejected browser origin %s - add it to TLUXE_AI_ALLOWED_ORIGINS if it is a TLUXE preview", provider.redact(origin))
            return False

        def _cors(self) -> None:
            origin = self.headers.get("Origin")
            if origin and origin in cfg.allowed_origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Max-Age", "600")
                if self.headers.get("Access-Control-Request-Private-Network") == "true":
                    self.send_header("Access-Control-Allow-Private-Network", "true")

        def _json(self, status: int, body: dict) -> None:
            data = provider.redact(json.dumps(body, separators=(",", ":"), ensure_ascii=False)).encode()
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

        def _authorised(self) -> bool:
            auth = self.headers.get("Authorization", "")
            given = auth[7:].encode() if auth.startswith("Bearer ") else b""
            return hmac.compare_digest(given, token)

        def _guard(self) -> bool:
            if not self._origin_ok():
                self._error(403, "ORIGIN_NOT_ALLOWED", "This browser origin is not allowed to use TLUXE AI.")
                return False
            if not self._authorised():
                self._error(401, "UNAUTHORIZED", "Missing or invalid TLUXE AI bridge token.")
                return False
            return True

        def do_OPTIONS(self):  # noqa: N802
            if not self._origin_ok():
                return self._error(403, "ORIGIN_NOT_ALLOWED", "This browser origin is not allowed to use TLUXE AI.")
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):  # noqa: N802
            if not self._guard():
                return
            path = self.path.split("?", 1)[0].rstrip("/")
            if path != "/api/ai/health":
                return self._error(404, "NOT_FOUND", "Unknown endpoint.")
            try:
                h = provider.health(force="refresh=1" in self.path)
            except Exception:  # pragma: no cover - defensive
                log.exception("health failed")
                h = {"status": "ERROR", "connected": False, "reason": "Health check failed.", "checkedAtMs": None}
            self._json(200, {
                "service": "tluxe-ai",
                "version": __version__,
                "startedAtMs": started_ms,
                "provider": "openai",
                "api": "responses",
                "model": cfg.model,
                **h,
                "permissions": READ_ONLY_PERMISSIONS,
                "capabilities": {"chat": True, "research": False, "analysis": False, "tools": False},
                "limits": {"maxMessages": MAX_MESSAGES, "maxMessageChars": MAX_MESSAGE_CHARS, "maxTotalChars": MAX_TOTAL_CHARS,
                           "maxContextBytes": MAX_CONTEXT_BYTES, "maxBodyBytes": MAX_BODY_BYTES, "timeoutS": cfg.timeout_s,
                           "maxOutputTokens": cfg.max_output_tokens},
            })

        def _read_json(self):
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json":
                raise ValidationError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.")
            raw_len = self.headers.get("Content-Length")
            if raw_len is None or not raw_len.isdigit():
                raise ValidationError("LENGTH_REQUIRED", "Content-Length is required.")
            n = int(raw_len)
            if n > MAX_BODY_BYTES:
                raise ValidationError("BODY_TOO_LARGE", f"The request body may be at most {MAX_BODY_BYTES} bytes.")
            try:
                return json.loads(self.rfile.read(n).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise ValidationError("INVALID_JSON", "The request body is not valid JSON.") from None

        def do_POST(self):  # noqa: N802
            if not self._guard():
                return
            if self.path.split("?", 1)[0].rstrip("/") != "/api/ai/chat":
                return self._error(404, "NOT_FOUND", "Unknown endpoint.")
            try:
                messages, context, rid = validate_chat(self._read_json())
            except ValidationError as v:
                status = {"BODY_TOO_LARGE": 413, "UNSUPPORTED_MEDIA_TYPE": 415, "LENGTH_REQUIRED": 411}.get(v.code, 400)
                if status in (413, 411):
                    self.close_connection = True
                return self._error(status, v.code, v.message)
            if not slots.acquire(blocking=False):
                return self._error(429, "BUSY", "TLUXE AI is already answering other requests - try again shortly.")
            try:
                out = provider.chat(messages, context)
            except ProviderError as e:
                return self._error(e.http_status, e.code, provider.redact(e.message))
            except Exception:  # pragma: no cover - defensive; details only in the (redacted) log
                log.exception("chat failed")
                return self._error(500, "ERROR", "Internal TLUXE AI error.")
            finally:
                slots.release()
            self._json(200, {**out, "requestId": rid})

    return Handler


class ExclusiveHTTPServer(ThreadingHTTPServer):
    """Never shares its port (a second backend on the same port fails loudly)."""

    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self) -> None:
        excl = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        if os.name == "nt" and excl is not None:
            self.socket.setsockopt(socket.SOL_SOCKET, excl, 1)
        super().server_bind()


def serve(cfg: AiConfig, provider: OpenAIProvider, started_ms: int = 0) -> ThreadingHTTPServer:
    return ExclusiveHTTPServer((cfg.host, cfg.port), make_handler(cfg, provider, started_ms))
