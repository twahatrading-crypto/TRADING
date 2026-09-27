"""TLUXE AI backend configuration (environment / local .env).

OPENAI_API_KEY is read from the environment ONLY, kept in a `Secret` whose repr never reveals it, and is never
logged, returned by an endpoint or sent to the browser. Without it the backend still starts and reports
NOT_CONFIGURED (the UI shows "Not Connected"). The bridge token is required (fail closed).
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

MIN_TOKEN_LENGTH = 32
DEFAULT_MODEL = "gpt-5.5"
DEFAULT_PORT = 8767  # MT5 bridge 8765 · Databento bridge 8766 · TLUXE AI 8767
DEFAULT_ORIGINS = (
    "http://localhost:5182", "http://127.0.0.1:5182",
    "http://localhost:5181", "http://127.0.0.1:5181",
    "http://localhost:4181", "http://127.0.0.1:4181",
)
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")
_ORIGIN_RE = re.compile(r"^https?://[A-Za-z0-9.\-\[\]:]+$")


class ConfigError(ValueError):
    """Configuration problem. Messages NEVER contain secret values."""


class Secret:
    __slots__ = ("_v",)

    def __init__(self, value: str) -> None:
        self._v = value

    def reveal(self) -> str:
        return self._v

    def __repr__(self) -> str:
        return "Secret(****)"

    __str__ = __repr__

    def __bool__(self) -> bool:
        return bool(self._v)


def load_dotenv(path: Path) -> None:
    """Minimal .env loader (KEY=VALUE lines). Existing environment wins."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


@dataclass(frozen=True)
class AiConfig:
    api_key: Secret = field(repr=False)
    token: Secret = field(repr=False)
    model: str = DEFAULT_MODEL
    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    allowed_origins: tuple[str, ...] = DEFAULT_ORIGINS
    timeout_s: int = 60
    max_output_tokens: int = 2000
    health_ttl_s: int = 300

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def __repr__(self) -> str:  # never expose secrets
        return f"AiConfig(host={self.host!r}, port={self.port}, model={self.model!r}, origins={self.allowed_origins!r})"


def _int(e: dict, key: str, default: int, lo: int, hi: int) -> int:
    raw = (e.get(key) or "").strip()
    if not raw:
        return default
    try:
        v = int(raw)
    except ValueError:
        raise ConfigError(f"{key} must be an integer") from None
    if not lo <= v <= hi:
        raise ConfigError(f"{key} must be between {lo} and {hi}")
    return v


def from_env(env: dict | None = None) -> AiConfig:
    e = dict(os.environ if env is None else env)
    key = (e.get("OPENAI_API_KEY") or "").strip()
    token = (e.get("TLUXE_AI_TOKEN") or "").strip()
    if len(token) < MIN_TOKEN_LENGTH:
        raise ConfigError(f"TLUXE_AI_TOKEN must be a random secret of at least {MIN_TOKEN_LENGTH} characters "
                          "(python -c \"import secrets; print(secrets.token_urlsafe(32))\").")
    if token.startswith("sk-") or (key and token == key):
        raise ConfigError("TLUXE_AI_TOKEN must not be the OpenAI API key (the bridge token is given to the browser).")
    host = (e.get("TLUXE_AI_HOST") or "127.0.0.1").strip()
    if host in ("0.0.0.0", "::", ""):
        raise ConfigError("Refusing to listen on all interfaces. TLUXE AI binds to 127.0.0.1 (local only).")
    model = (e.get("TLUXE_AI_MODEL") or DEFAULT_MODEL).strip()
    if not _MODEL_RE.match(model):
        raise ConfigError("TLUXE_AI_MODEL is not a valid model name")
    origins = tuple(o.strip() for o in (e.get("TLUXE_AI_ALLOWED_ORIGINS") or ",".join(DEFAULT_ORIGINS)).split(",") if o.strip())
    for o in origins:
        if o == "*" or not _ORIGIN_RE.match(o):
            raise ConfigError("TLUXE_AI_ALLOWED_ORIGINS must list exact origins such as http://localhost:5182 (never *)")
    return AiConfig(
        api_key=Secret(key),
        token=Secret(token),
        model=model,
        host=host,
        port=_int(e, "TLUXE_AI_PORT", DEFAULT_PORT, 1, 65535),
        allowed_origins=origins,
        timeout_s=_int(e, "TLUXE_AI_TIMEOUT_S", 60, 5, 300),
        max_output_tokens=_int(e, "TLUXE_AI_MAX_OUTPUT_TOKENS", 2000, 64, 32000),
        health_ttl_s=_int(e, "TLUXE_AI_HEALTH_TTL_S", 300, 30, 3600),
    )
