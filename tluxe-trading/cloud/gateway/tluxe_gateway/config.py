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
_HASH_RE = re.compile(r"^(scrypt\$\d+\$\d+\$\d+|pbkdf2_sha256\$\d+)\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$")
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
    # A misconfigured OPTIONAL upstream never stops the gateway: it is reported as ERROR in /api/status instead.
    problem: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.url) and bool(self.token) and not self.problem


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
    # IBKR COMEX Level-2 depth link from the cloud Windows VPS (/bridge/ibkr). Same hash format as the MT5 link key.
    ibkr_bridge_keys: tuple[Mt5BridgeKey, ...] = ()
    static_dir: str = ""
    log_format: str = "text"
    # Production without an owner password hash (login not set up yet): the gateway still starts, but ONLY the
    # read-only Databento market-data GET routes are served without a session; every other API stays 401.
    public_market_data: bool = False

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
    if "://" not in u and https_only:
        u = "https://" + u  # Railway shows domains without a scheme (xyz.up.railway.app)
    p = urlparse(u)
    if p.scheme not in ("http", "https") or not p.netloc:
        raise ConfigError(f"{key} must be an absolute http(s) URL")
    if https_only and p.scheme != "https":
        raise ConfigError(f"{key} must use https in production")
    return u


def _internal_url(raw: str, key: str) -> tuple[str, str]:
    """(url, problem). Bare `host[:port]` (e.g. a ${{svc.RAILWAY_PRIVATE_DOMAIN}} reference) becomes http://host[:port].
    A bad value is reported, never fatal - an optional upstream must not crash the gateway."""
    u = raw.strip().rstrip("/")
    if not u:
        return "", ""
    if "://" not in u:
        u = "http://" + u
    p = urlparse(u)
    if p.scheme not in ("http", "https") or not p.hostname or "${{" in u:
        return "", f"{key} is not a valid http(s) URL (e.g. http://tluxe-ai.railway.internal:8080)"
    try:
        p.port
    except ValueError:
        return "", f"{key} has an invalid port"
    return u, ""


def _mt5_keys(raw: str, name: str = "TLUXE_MT5_BRIDGE_TOKEN_SHA256") -> tuple[Mt5BridgeKey, ...]:
    """<NAME> = comma list of sha256(token) hex, optionally `hash@expiryEpochSeconds`.
    Two entries allow rotation without downtime; only hashes are stored in the cloud."""
    out = []
    for part in (raw or "").split(","):
        part = part.strip().lower()
        if not part:
            continue
        h, _, exp = part.partition("@")
        if not _SHA256_RE.match(h):
            raise ConfigError(f"{name} must be sha256 hex digests (optionally @expiryEpochSeconds)")
        try:
            out.append(Mt5BridgeKey(h, int(exp) if exp else None))
        except ValueError:
            raise ConfigError(f"{name} expiry must be epoch seconds") from None
    return tuple(out)


def from_env(env: dict | None = None) -> GatewayConfig:
    """Validate everything first and report EVERY problem at once (one redeploy fixes them all)."""
    e = dict(os.environ if env is None else env)
    errors: list[str] = []

    def check(fn, *a, default=None):
        try:
            return fn(*a)
        except ConfigError as exc:
            errors.append(str(exc))
            return default

    mode = (e.get("TLUXE_ENV") or "development").strip().lower()
    if mode not in ("production", "development"):
        raise ConfigError("TLUXE_ENV must be 'production' or 'development'")
    prod = mode == "production"
    # Railway injects RAILWAY_PUBLIC_DOMAIN once a public domain is generated: a sane default for the app URL.
    raw_public = e.get("PUBLIC_APP_URL") or (e.get("RAILWAY_PUBLIC_DOMAIN") if prod else "") or ""
    public_app_url = check(_url, raw_public, "PUBLIC_APP_URL", prod, default="")
    api_public_url = check(_url, e.get("API_PUBLIC_URL") or public_app_url or "", "API_PUBLIC_URL", prod, default="")
    raw_origins = (e.get("ALLOWED_ORIGINS") or "").strip()
    origins = tuple(o.strip().rstrip("/") for o in raw_origins.split(",") if o.strip()) if raw_origins else ()
    if prod:
        if not public_app_url and not errors:
            errors.append("PUBLIC_APP_URL is required in production (the Railway https domain or your custom domain)")
        origins = tuple(o if "://" in o or o == "*" else "https://" + o for o in origins) or ((public_app_url,) if public_app_url else ())
        for o in origins:
            p = urlparse(o)
            if o == "*" or "*" in o or p.scheme != "https" or not p.netloc or p.hostname in _LOCAL_HOSTS or p.path not in ("", "/"):
                errors.append("ALLOWED_ORIGINS in production must be exact https origins (never *, never localhost)")
                break
        if not (e.get("DATABASE_URL") or "").strip():
            errors.append("DATABASE_URL is required in production (reference the Railway PostgreSQL service: ${{Postgres.DATABASE_URL}})")
        raw_hash = (e.get("TLUXE_OWNER_PASSWORD_HASH") or "").strip()
        if raw_hash and not _HASH_RE.match(raw_hash):
            errors.append("TLUXE_OWNER_PASSWORD_HASH must be a scrypt or pbkdf2_sha256 hash (tools/owner-password-hash.html or python -m tluxe_gateway.hashpw)")
    else:
        origins = origins or DEV_ORIGINS
        for o in origins:
            if o == "*" or "*" in o:
                errors.append("ALLOWED_ORIGINS must list exact origins (never *)")
                break
    pw_hash = (e.get("TLUXE_OWNER_PASSWORD_HASH") or "").strip()
    if pw_hash and not _HASH_RE.match(pw_hash) and not prod:
        errors.append("TLUXE_OWNER_PASSWORD_HASH has an invalid format (tools/owner-password-hash.html or python -m tluxe_gateway.hashpw)")
    # Railway assigns PORT: it always wins in production, so a stale TLUXE_GATEWAY_PORT can never mis-bind the service.
    railway_port = (e.get("PORT") or "").strip()
    if prod and railway_port:
        port = check(_int, {"PORT": railway_port}, "PORT", DEV_PORT, 1, 65535, default=0)
    else:
        port = check(_int, e, "TLUXE_GATEWAY_PORT", int(railway_port) if railway_port.isdigit() else DEV_PORT, 1, 65535, default=0)
    host = (e.get("TLUXE_GATEWAY_HOST") or ("0.0.0.0" if prod else "127.0.0.1")).strip()
    log_format = (e.get("LOG_FORMAT") or ("json" if prod else "text")).strip().lower()
    if log_format not in ("json", "text"):
        errors.append("LOG_FORMAT must be json or text")
    ttl_h = check(_int, e, "TLUXE_SESSION_TTL_HOURS", 12, 1, 24 * 30, default=12)
    mt5_keys = check(_mt5_keys, e.get("TLUXE_MT5_BRIDGE_TOKEN_SHA256") or "", default=())
    ibkr_keys = check(_mt5_keys, e.get("TLUXE_IBKR_BRIDGE_TOKEN_SHA256") or "", "TLUXE_IBKR_BRIDGE_TOKEN_SHA256", default=())
    if errors:
        raise ConfigError("; ".join(dict.fromkeys(errors)))

    def upstream(name: str, url_key: str, token_key: str) -> Upstream:
        url, problem = _internal_url(e.get(url_key) or "", url_key)
        return Upstream(name, url, Secret((e.get(token_key) or "").strip()), problem)

    return GatewayConfig(
        env=mode,
        host=host,
        port=port,
        public_app_url=public_app_url,
        api_public_url=api_public_url,
        allowed_origins=origins,
        database_url=Secret((e.get("DATABASE_URL") or "").strip()),
        owner_password_hash=Secret(pw_hash),
        session_ttl_s=ttl_h * 3600,
        ai=upstream("ai", "TLUXE_AI_URL", "TLUXE_AI_TOKEN"),
        databento=upstream("databento", "TLUXE_DATABENTO_URL", "TLUXE_DB_BRIDGE_TOKEN"),
        news=upstream("news", "TLUXE_NEWS_URL", "TLUXE_NEWS_TOKEN"),
        mt5_bridge_keys=mt5_keys,
        ibkr_bridge_keys=ibkr_keys,
        static_dir=(e.get("TLUXE_STATIC_DIR") or "").strip(),
        log_format=log_format,
        # No owner login configured yet -> read-only public market data only (login returns AUTH_NOT_CONFIGURED).
        public_market_data=not pw_hash,
    )
