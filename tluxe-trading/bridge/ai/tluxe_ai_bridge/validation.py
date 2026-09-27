"""Request validation + context sanitising for POST /api/ai/chat.

Only plain conversation turns are accepted (role user | assistant, text content). The optional `context` is the
browser's READ-ONLY market / engine snapshot: it is size-bounded and scrubbed of anything secret-shaped before it
is ever shown to the model. Nothing here can make the model act: no tools are exposed.
"""
from __future__ import annotations

import json
import re

MAX_BODY_BYTES = 256_000
MAX_MESSAGES = 40
MAX_MESSAGE_CHARS = 8_000
MAX_TOTAL_CHARS = 64_000
MAX_CONTEXT_BYTES = 24_000
MAX_CONTEXT_DEPTH = 8
ROLES = ("user", "assistant")
BODY_KEYS = {"messages", "context", "mode", "requestId"}
MODES = ("chat",)  # Phase 1: Chat only (research / analysis / tools are not implemented and are refused)

_SECRET_KEY = re.compile(r"(api[_-]?key|secret|token|password|passwd|authorization|bearer|credential|private[_-]?key|cookie|session[_-]?id|login)", re.I)
_SECRET_VALUE = re.compile(r"\b(sk-[A-Za-z0-9_\-]{8,}|db-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._\-]{8,})")
_REQUEST_ID = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


class ValidationError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def sanitize_context(value, depth: int = 0):
    """Deep copy keeping only JSON primitives; secret-looking keys are dropped, secret-looking values masked."""
    if depth > MAX_CONTEXT_DEPTH:
        return "…"
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if not isinstance(k, str) or _SECRET_KEY.search(k):
                continue
            out[k[:64]] = sanitize_context(v, depth + 1)
        return out
    if isinstance(value, list):
        return [sanitize_context(v, depth + 1) for v in value[:200]]
    if isinstance(value, str):
        return _SECRET_VALUE.sub("****", value[:2000])
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        return value if value == value and value not in (float("inf"), float("-inf")) else None
    return None


def validate_chat(body: object) -> tuple[list[dict], dict | None, str | None]:
    """Returns (messages, sanitised context or None, requestId or None) or raises ValidationError."""
    if not isinstance(body, dict):
        raise ValidationError("INVALID_BODY", "The request body must be a JSON object.")
    extra = set(body) - BODY_KEYS
    if extra:
        raise ValidationError("INVALID_BODY", f"Unknown field(s): {', '.join(sorted(extra))[:120]}")
    mode = body.get("mode", "chat")
    if mode not in MODES:
        raise ValidationError("MODE_NOT_AVAILABLE", "Only Chat is available in this phase.")
    msgs = body.get("messages")
    if not isinstance(msgs, list) or not msgs:
        raise ValidationError("INVALID_MESSAGES", "messages must be a non-empty list.")
    if len(msgs) > MAX_MESSAGES:
        raise ValidationError("TOO_MANY_MESSAGES", f"At most {MAX_MESSAGES} messages per request.")
    clean, total = [], 0
    for m in msgs:
        if not isinstance(m, dict) or set(m) - {"role", "content"}:
            raise ValidationError("INVALID_MESSAGES", "Each message must be {role, content}.")
        role, content = m.get("role"), m.get("content")
        if role not in ROLES:
            raise ValidationError("INVALID_ROLE", "role must be 'user' or 'assistant'.")
        if not isinstance(content, str) or not content.strip():
            raise ValidationError("INVALID_CONTENT", "content must be non-empty text.")
        if len(content) > MAX_MESSAGE_CHARS:
            raise ValidationError("MESSAGE_TOO_LONG", f"A message may have at most {MAX_MESSAGE_CHARS} characters.")
        total += len(content)
        clean.append({"role": role, "content": content})
    if total > MAX_TOTAL_CHARS:
        raise ValidationError("CONVERSATION_TOO_LONG", "The conversation is too long - clear it and start again.")
    if clean[-1]["role"] != "user":
        raise ValidationError("INVALID_MESSAGES", "The last message must be from the user.")
    ctx = body.get("context")
    if ctx is not None:
        if not isinstance(ctx, dict):
            raise ValidationError("INVALID_CONTEXT", "context must be an object.")
        if len(json.dumps(ctx, separators=(",", ":"))) > MAX_CONTEXT_BYTES:
            raise ValidationError("CONTEXT_TOO_LARGE", f"context may be at most {MAX_CONTEXT_BYTES} bytes.")
        ctx = sanitize_context(ctx)
    rid = body.get("requestId")
    if rid is not None and (not isinstance(rid, str) or not _REQUEST_ID.match(rid)):
        raise ValidationError("INVALID_BODY", "requestId must be a short id.")
    return clean, ctx, rid
