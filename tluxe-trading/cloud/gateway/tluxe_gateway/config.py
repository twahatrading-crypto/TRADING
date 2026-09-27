"""Gateway configuration - environment only (Railway variables in production, a local .env in development).

Production (TLUXE_ENV=production) FAILS CLOSED unless:
  * PUBLIC_APP_URL is https, ALLOWED_ORIGINS lists exact https origins (never "*", never localhost),
  * DATABASE_URL is set (PostgreSQL is the durable store),
  * TLUXE_OWNER_PASSWORD_HASH is set (owner login -> rotating HttpOnly session cookies; no static browser secret).
Development keeps the localhost origins (5182 / 5181 / 4181) and may run without a database (in-memory sessions).
Secrets are wrapped so repr / logs never reveal them; internal service tokens never reach the browser.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

DEV_PORT = 8780  # MT5 8765 · Databento 8766 · TLUXE AI 8767 · News 8768 · Vite 5182 · gateway (dev) 8780
DEV_ORIGINS = ("http://localhost:5182", "http://127.0.0.1:5182", "http://localhost:5181", "http://127.0.0.1:5181",
               "http://localhost:4181", "http://127.0.0.1:4181")
_LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1", "0.0.0.0")
_HASH_RE = re.compile(r"^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class ConfigError(ValueError):
    """Configuration problem. Messages NEVER contain secret values."""


class Secret:
    __slots__ = ("_v",)

    def __init__(self, value: str) -> None:
        self._v = value or ""

    def reveal(self) -> str:
        return self._v

    def __repr__(self) -> str:
        return "Secret(****)"

    __str__ = __repr__

    def __bool__(self) -> bool:
        return bool(self._v)


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


@dataclass(frozen=True)
class Upstream:
    """An internal (private-network) service and the server-side token used to call it."""

    name: str
    url: str
    token: Secret = field(repr=False)

    @property
    def configured(self) -> bool:
        return bool(self.url) and bool(self.token)


@dataclass(frozen=True)
class Mt5BridgeKey:
    sha256: str
    expires_at: int | None  # epoch seconds; None = no expiry (rotate by replacing the list)


@dataclass(frozen=True)
class GatewayConfig:
    env: str
    host: str
    port: int
    public_app_url: str
    api_public_url: str
    allowed_origins: tuple[str, ...]
    database_url: Secret = field(repr=False)
    owner_password_hash: Secret = field(repr=False)
    session_ttl_s: int = 12 * 3600
    ai: Upstream = field(default_factory=lambda: Upstream("ai", "", Secret("")))
    databento: Upstream = field(default_factory=lambda: Upstream("databento", "", Secret("")))
    news: Upstream = field(default_factory=lambda: Upstream("news", "", Secret("")))
    mt5_bridge_keys: tuple[Mt5BridgeKey, ...] = ()
    static_dir: str = ""
    log_format: str = "text"

    @property
    def production(self) -> bool:
        return self.env == "production"

    @property
    def cookie_secure(self) -> bool:
        return self.production

    def secrets(self) -> list[str]:
        """Every secret value (for log / response redaction)."""
        vals = [self.database_url.reveal(), self.owner_password_hash.reveal(), self.ai.token.reveal(), self.databento.token.reveal(), self.news.token.reveal()]
        pw = urlparse(self.database_url.reveal()).password if self.database_url else None
        return [v for v in vals + [pw or ""] if v]

    def __repr__(self) -> str:
        return f"GatewayConfig(env={self.env!r}, host={self.host!r}, port={self.port}, origins={self.allowed_origins!r})"


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


def _url(raw: str, key: str, https_only: bool) -> str:
    u = raw.strip().rstrip("/")
    if not u:
        return ""
    p = urlparse(u)
    if p.scheme not in ("http", "https") or not p.netloc:
        raise ConfigError(f"{key} must be an absolute http(s) URL")
    if https_only and p.scheme != "https":
        raise ConfigError(f"{key} must use https in production")
    return u


def _internal_url(raw: str, key: str) -> str:
    u = raw.strip().rstrip("/")
    if u and urlparse(u).scheme not in ("http", "https"):
        raise ConfigError(f"{key} must be an http(s) URL (Railway private network, e.g. http://tluxe-ai.railway.internal:8767)")
    return u


def _mt5_keys(raw: str) -> tuple[Mt5BridgeKey, ...]:
    """TLUXE_MT5_BRIDGE_TOKEN_SHA256 = comma list of sha256(token) hex, optionally `hash@expiryEpochSeconds`.
    Two entries allow rotation without downtime; only hashes are stored in the cloud."""
    out = []
    for part in (raw or "").split(","):
        part = part.strip().lower()
        if not part:
            continue
        h, _, exp = part.partition("@")
        if not _SHA256_RE.match(h):
            raise ConfigError("TLUXE_MT5_BRIDGE_TOKEN_SHA256 must be sha256 hex digests (optionally @expiryEpochSeconds)")
        try:
            out.append(Mt5BridgeKey(h, int(exp) if exp else None))
        except ValueError:
            raise ConfigError("TLUXE_MT5_BRIDGE_TOKEN_SHA256 expiry must be epoch seconds") from None
    return tuple(out)


def from_env(env: dict | None = None) -> GatewayConfig:
    e = dict(os.environ if env is None else env)
    mode = (e.get("TLUXE_ENV") or "development").strip().lower()
    if mode not in ("production", "development"):
        raise ConfigError("TLUXE_ENV must be 'production' or 'development'")
    prod = mode == "production"
    public_app_url = _url(e.get("PUBLIC_APP_URL") or "", "PUBLIC_APP_URL", prod)
    api_public_url = _url(e.get("API_PUBLIC_URL") or public_app_url, "API_PUBLIC_URL", prod)
    raw_origins = (e.get("ALLOWED_ORIGINS") or "").strip()
    origins = tuple(o.strip().rstrip("/") for o in raw_origins.split(",") if o.strip()) if raw_origins else ()
    if prod:
        if not public_app_url:
            raise ConfigError("PUBLIC_APP_URL is required in production (the Railway https domain or your custom domain)")
        if not origins:
            origins = (public_app_url,)
        for o in origins:
            p = urlparse(o)
            if o == "*" or "*" in o or p.scheme != "https" or not p.netloc or p.hostname in _LOCAL_HOSTS or p.path not in ("", "/"):
                raise ConfigError("ALLOWED_ORIGINS in production must be exact https origins (never *, never localhost)")
        if not e.get("DATABASE_URL"):
            raise ConfigError("DATABASE_URL is required in production (Railway PostgreSQL)")
        if not _HASH_RE.match((e.get("TLUXE_OWNER_PASSWORD_HASH") or "").strip()):
            raise ConfigError("TLUXE_OWNER_PASSWORD_HASH is required in production (python -m tluxe_gateway.hashpw)")
    else:
        origins = origins or DEV_ORIGINS
        for o in origins:
            if o == "*" or "*" in o:
                raise ConfigError("ALLOWED_ORIGINS must list exact origins (never *)")
    pw_hash = (e.get("TLUXE_OWNER_PASSWORD_HASH") or "").strip()
    if pw_hash and not _HASH_RE.match(pw_hash):
        raise ConfigError("TLUXE_OWNER_PASSWORD_HASH has an invalid format (python -m tluxe_gateway.hashpw)")
    port_default = int(e["PORT"]) if (e.get("PORT") or "").isdigit() else DEV_PORT
    host = (e.get("TLUXE_GATEWAY_HOST") or ("::" if prod else "127.0.0.1")).strip()
    log_format = (e.get("LOG_FORMAT") or ("json" if prod else "text")).strip().lower()
    if log_format not in ("json", "text"):
        raise ConfigError("LOG_FORMAT must be json or text")
    return GatewayConfig(
        env=mode,
        host=host,
        port=_int(e, "TLUXE_GATEWAY_PORT", port_default, 1, 65535),
        public_app_url=public_app_url,
        api_public_url=api_public_url,
        allowed_origins=origins,
        database_url=Secret((e.get("DATABASE_URL") or "").strip()),
        owner_password_hash=Secret(pw_hash),
        session_ttl_s=_int(e, "TLUXE_SESSION_TTL_HOURS", 12, 1, 24 * 30) * 3600,
        ai=Upstream("ai", _internal_url(e.get("TLUXE_AI_URL") or "", "TLUXE_AI_URL"), Secret((e.get("TLUXE_AI_TOKEN") or "").strip())),
        databento=Upstream("databento", _internal_url(e.get("TLUXE_DATABENTO_URL") or "", "TLUXE_DATABENTO_URL"), Secret((e.get("TLUXE_DB_BRIDGE_TOKEN") or "").strip())),
        news=Upstream("news", _internal_url(e.get("TLUXE_NEWS_URL") or "", "TLUXE_NEWS_URL"), Secret((e.get("TLUXE_NEWS_TOKEN") or "").strip())),
        mt5_bridge_keys=_mt5_keys(e.get("TLUXE_MT5_BRIDGE_TOKEN_SHA256") or ""),
        static_dir=(e.get("TLUXE_STATIC_DIR") or "").strip(),
        log_format=log_format,
    )
