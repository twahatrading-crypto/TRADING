"""OpenAI Responses API access for TLUXE AI (the ONLY place the OpenAI key is used).

READ-ONLY by construction: the model receives the conversation plus an optional read-only context block and NO
tools - it cannot call functions, place or modify orders, control MT5, run commands, touch files or read the
environment. Answers are returned as text; nothing the model says is executed.
"""
from __future__ import annotations

import json
import threading
import time
from typing import Callable

from .config import AiConfig, Secret
from .redact import Redactor

SYSTEM_INSTRUCTIONS = """You are TLUXE AI, the research and development assistant inside the Trading by TLUXE platform.

Operating limits (phase 1, READ-ONLY):
- You cannot place, modify or cancel trades or orders, control MetaTrader 5 or any broker, run shell commands,
  read or write files, change engine settings, or access credentials or environment variables. You have no tools.
  If asked to do any of this, say it is not available and, where useful, explain what the user could do themselves.
- Never claim to have performed an action.
- Market / engine facts may ONLY come from the READ-ONLY TLUXE CONTEXT block below (if present) or from the user.
  Each context field carries a status (LIVE, DELAYED, STALE, UNAVAILABLE) and a source. Treat UNAVAILABLE as
  unknown. Never invent prices, levels, signals, news or engine results; say plainly when data is unavailable,
  stale or delayed, and name its source.
- News / calendar items in the context are OBSERVED PROVIDER DATA (each has a provider evidence key). Label them as
  observed (with provider and time) and keep any conclusion you draw clearly marked as AI INTERPRETATION. If the news
  section is UNAVAILABLE or an Actual value is null, say so - never invent events, headlines, values or sentiment.
- You give research and educational analysis, not personalised financial advice; note risk where relevant.
- Answer in concise Markdown. Use code blocks for code."""


def _default_client_factory(api_key: Secret, timeout_s: int):
    from openai import OpenAI

    # max_retries 1: a failing call surfaces quickly; the browser offers Retry.
    return OpenAI(api_key=api_key.reveal(), timeout=float(timeout_s), max_retries=1)


class ProviderError(Exception):
    def __init__(self, code: str, message: str, http_status: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


def _classify(exc: BaseException) -> ProviderError:
    import openai

    if isinstance(exc, openai.AuthenticationError):
        return ProviderError("PROVIDER_AUTH", "OpenAI rejected the API key (check OPENAI_API_KEY on the TLUXE AI backend).", 502)
    if isinstance(exc, openai.PermissionDeniedError):
        return ProviderError("PROVIDER_PERMISSION", "The OpenAI project has no access to the configured model.", 502)
    if isinstance(exc, openai.NotFoundError):
        return ProviderError("MODEL_UNAVAILABLE", "The configured model (TLUXE_AI_MODEL) is not available to this API key.", 502)
    if isinstance(exc, openai.RateLimitError):
        return ProviderError("RATE_LIMITED", "OpenAI rate limit or quota reached - try again later.", 429)
    if isinstance(exc, openai.APITimeoutError):
        return ProviderError("TIMEOUT", "OpenAI did not answer in time.", 504)
    if isinstance(exc, openai.APIConnectionError):
        return ProviderError("PROVIDER_UNREACHABLE", "The TLUXE AI backend cannot reach OpenAI (network).", 502)
    if isinstance(exc, openai.BadRequestError):
        return ProviderError("PROVIDER_REJECTED", "OpenAI rejected the request.", 502)
    if isinstance(exc, openai.APIStatusError):
        return ProviderError("PROVIDER_ERROR", f"OpenAI error (HTTP {getattr(exc, 'status_code', '?')}).", 502)
    return ProviderError("PROVIDER_ERROR", "Unexpected error while calling OpenAI.", 502)


class OpenAIProvider:
    HEALTH_ERROR_TTL_S = 30

    def __init__(self, cfg: AiConfig, client_factory: Callable | None = None, clock: Callable[[], float] = time.time) -> None:
        self.cfg = cfg
        self.redact = Redactor(cfg.api_key.reveal(), cfg.token.reveal())
        self._factory = client_factory or _default_client_factory
        self._client = None
        self._lock = threading.Lock()
        self._clock = clock
        self._health: dict | None = None
        self._health_at = 0.0

    def _get_client(self):
        with self._lock:
            if self._client is None:
                self._client = self._factory(self.cfg.api_key, self.cfg.timeout_s)
            return self._client

    # ------------------------------------------------------------------ health
    def _set_health(self, status: str, reason: str | None) -> dict:
        self._health = {"status": status, "connected": status == "CONNECTED", "reason": reason, "checkedAtMs": int(self._clock() * 1000)}
        self._health_at = self._clock()
        return self._health

    def health(self, force: bool = False) -> dict:
        """CONNECTED only after OpenAI itself confirmed the key AND the configured model (models.retrieve - no tokens
        spent). Cached (TTL) so browser polling never hammers OpenAI. Never contains the key."""
        if not self.cfg.configured:
            return {"status": "NOT_CONFIGURED", "connected": False, "reason": "OPENAI_API_KEY is not set on the TLUXE AI backend.", "checkedAtMs": int(self._clock() * 1000)}
        h = self._health
        ttl = self.cfg.health_ttl_s if (h and h["connected"]) else self.HEALTH_ERROR_TTL_S
        if h is not None and not force and self._clock() - self._health_at < ttl:
            return h
        try:
            self._get_client().models.retrieve(self.cfg.model)
        except Exception as exc:  # noqa: BLE001 - classified, redacted
            err = _classify(exc)
            status = {"PROVIDER_AUTH": "AUTH_ERROR", "MODEL_UNAVAILABLE": "MODEL_UNAVAILABLE", "PROVIDER_PERMISSION": "MODEL_UNAVAILABLE",
                      "RATE_LIMITED": "RATE_LIMITED", "TIMEOUT": "UNREACHABLE", "PROVIDER_UNREACHABLE": "UNREACHABLE"}.get(err.code, "ERROR")
            return self._set_health(status, self.redact(err.message))
        return self._set_health("CONNECTED", None)

    # ------------------------------------------------------------------ chat
    def chat(self, messages: list[dict], context: dict | None) -> dict:
        if not self.cfg.configured:
            raise ProviderError("NOT_CONFIGURED", "TLUXE AI is not connected: OPENAI_API_KEY is not set on the backend.", 503)
        instructions = SYSTEM_INSTRUCTIONS
        if context:
            instructions += "\n\nREAD-ONLY TLUXE CONTEXT (provenance-tagged; UNAVAILABLE = unknown, never fill it in):\n" + json.dumps(context, separators=(",", ":"), ensure_ascii=False)
        try:
            res = self._get_client().responses.create(
                model=self.cfg.model,
                instructions=instructions,
                input=[{"role": m["role"], "content": m["content"]} for m in messages],
                max_output_tokens=self.cfg.max_output_tokens,
                store=False,
            )
        except Exception as exc:  # noqa: BLE001 - classified, redacted
            err = _classify(exc)
            if err.code in ("PROVIDER_AUTH", "MODEL_UNAVAILABLE", "PROVIDER_PERMISSION"):
                self._set_health({"PROVIDER_AUTH": "AUTH_ERROR"}.get(err.code, "MODEL_UNAVAILABLE"), err.message)
            raise err from None
        text = (getattr(res, "output_text", None) or "").strip()
        status = getattr(res, "status", None)
        if not text:
            # Never substitute a placeholder answer.
            raise ProviderError("EMPTY_RESPONSE", "OpenAI returned no text" + (" (response incomplete - try a shorter question)." if status == "incomplete" else "."), 502)
        self._set_health("CONNECTED", None)
        usage = getattr(res, "usage", None)
        return {
            "text": text,
            "model": getattr(res, "model", None) or self.cfg.model,
            "responseId": getattr(res, "id", None),
            "incomplete": status == "incomplete",
            "usage": {"inputTokens": getattr(usage, "input_tokens", None), "outputTokens": getattr(usage, "output_tokens", None)} if usage else None,
        }
