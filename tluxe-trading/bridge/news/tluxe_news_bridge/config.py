"""News backend configuration (environment / local .env).

Provider credentials are read from the environment ONLY, kept in `Secret` wrappers that never print their value, and
are never logged, returned by an endpoint or sent to the browser. Without a Trading Economics key the backend still
starts and every feed reports NOT_CONFIGURED (the News Analysis page stays DATA UNAVAILABLE).
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

MIN_TOKEN_LENGTH = 32
DEFAULT_PORT = 8768  # MT5 8765 · Databento 8766 · TLUXE AI 8767 · News 8768
DEFAULT_ORIGINS = (
    "http://localhost:5182", "http://127.0.0.1:5182",
    "http://localhost:5181", "http://127.0.0.1:5181",
    "http://localhost:4181", "http://127.0.0.1:4181",
)
DEFAULT_COUNTRIES = ("united states", "euro area", "united kingdom", "canada", "japan", "china", "switzerland", "australia", "germany")
TE_REST_BASE = "https://api.tradingeconomics.com"
TE_STREAM_URL = "wss://stream.tradingeconomics.com/"
BREAKING_PROVIDERS: tuple[str, ...] = ()  # no licensed breaking-news adapter is implemented / configured yet
_ORIGIN_RE = re.compile(r"^https?://[A-Za-z0-9.\-\[\]:]+$")
_COUNTRY_RE = re.compile(r"^[a-z .'-]{2,40}$")


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
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


@dataclass(frozen=True)
class NewsConfig:
    te_key: Secret = field(repr=False)
    token: Secret = field(repr=False)
    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    allowed_origins: tuple[str, ...] = DEFAULT_ORIGINS
    calendar_enabled: bool = True
    countries: tuple[str, ...] = DEFAULT_COUNTRIES
    days_back: int = 1
    days_ahead: int = 7
    streaming: str = "auto"  # auto | off
    calendar_refresh_s: int = 900
    updates_refresh_s: int = 300
    updates_fast_s: int = 60
    news_enabled: bool = False
    news_refresh_s: int = 300
    breaking_provider: str = ""
    rest_base: str = TE_REST_BASE
    stream_url: str = TE_STREAM_URL

    @property
    def te_configured(self) -> bool:
        return bool(self.te_key)

    @property
    def te_demo(self) -> bool:
        """The public Trading Economics guest key only returns sample data for a few countries."""
        return self.te_key.reveal().strip().lower() == "guest:guest"

    def __repr__(self) -> str:  # never expose secrets
        return f"NewsConfig(host={self.host!r}, port={self.port}, calendar={self.calendar_enabled}, news={self.news_enabled}, streaming={self.streaming!r})"


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


def _bool(e: dict, key: str, default: bool) -> bool:
    raw = (e.get(key) or "").strip().lower()
    return default if not raw else raw in ("1", "true", "yes", "on")


def from_env(env: dict | None = None) -> NewsConfig:
    e = dict(os.environ if env is None else env)
    key = (e.get("TRADING_ECONOMICS_API_KEY") or "").strip()
    token = (e.get("TLUXE_NEWS_TOKEN") or "").strip()
    if len(token) < MIN_TOKEN_LENGTH:
        raise ConfigError(f"TLUXE_NEWS_TOKEN must be a random secret of at least {MIN_TOKEN_LENGTH} characters "
                          "(python -c \"import secrets; print(secrets.token_urlsafe(32))\").")
    if key and token == key:
        raise ConfigError("TLUXE_NEWS_TOKEN must not be the Trading Economics key (the backend token is given to the browser).")
    host = (e.get("TLUXE_NEWS_HOST") or "127.0.0.1").strip()
    if host in ("0.0.0.0", "::", ""):
        raise ConfigError("Refusing to listen on all interfaces. The news backend binds to 127.0.0.1 (local only).")
    origins = tuple(o.strip() for o in (e.get("TLUXE_NEWS_ALLOWED_ORIGINS") or ",".join(DEFAULT_ORIGINS)).split(",") if o.strip())
    for o in origins:
        if o == "*" or not _ORIGIN_RE.match(o):
            raise ConfigError("TLUXE_NEWS_ALLOWED_ORIGINS must list exact origins such as http://localhost:5182 (never *)")
    countries = tuple(c.strip().lower() for c in (e.get("TE_CALENDAR_COUNTRIES") or ",".join(DEFAULT_COUNTRIES)).split(",") if c.strip())
    for c in countries:
        if not _COUNTRY_RE.match(c):
            raise ConfigError("TE_CALENDAR_COUNTRIES must be Trading Economics country names (e.g. united states,euro area)")
    streaming = (e.get("TE_STREAMING") or "auto").strip().lower()
    if streaming not in ("auto", "off"):
        raise ConfigError("TE_STREAMING must be 'auto' or 'off'")
    breaking = (e.get("TLUXE_BREAKING_PROVIDER") or "").strip().lower()
    if breaking and breaking not in BREAKING_PROVIDERS:
        raise ConfigError("TLUXE_BREAKING_PROVIDER: no licensed breaking-news adapter is implemented yet - leave it empty.")
    return NewsConfig(
        te_key=Secret(key),
        token=Secret(token),
        host=host,
        port=_int(e, "TLUXE_NEWS_PORT", DEFAULT_PORT, 1, 65535),
        allowed_origins=origins,
        calendar_enabled=_bool(e, "TE_CALENDAR_ENABLED", True),
        countries=countries,
        days_back=_int(e, "TE_CALENDAR_DAYS_BACK", 1, 0, 14),
        days_ahead=_int(e, "TE_CALENDAR_DAYS_AHEAD", 7, 1, 31),
        streaming=streaming,
        calendar_refresh_s=_int(e, "TE_CALENDAR_REFRESH_S", 900, 300, 86400),
        updates_refresh_s=_int(e, "TE_UPDATES_REFRESH_S", 300, 60, 3600),
        updates_fast_s=_int(e, "TE_UPDATES_FAST_S", 60, 30, 600),
        news_enabled=_bool(e, "TE_NEWS_ENABLED", False),
        news_refresh_s=_int(e, "TE_NEWS_REFRESH_S", 300, 120, 3600),
        breaking_provider=breaking,
    )
