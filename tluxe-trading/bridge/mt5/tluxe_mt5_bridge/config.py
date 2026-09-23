"""Bridge configuration from environment variables / a local .env file.

Secrets (token, optional MT5 password) are read from the environment only and
are never logged or returned by any endpoint.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

MIN_TOKEN_LENGTH = 32


class ConfigError(ValueError):
    pass


def load_dotenv(path: Path) -> None:
    """Minimal .env loader (KEY=VALUE lines). Existing environment wins."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


@dataclass(frozen=True)
class BridgeConfig:
    token: str
    host: str = "127.0.0.1"
    port: int = 8765
    allowed_origins: tuple[str, ...] = ("http://localhost:5180", "http://127.0.0.1:5180")
    server_timezone: str | None = None
    terminal_path: str | None = None
    login: int | None = None
    password: str | None = field(default=None, repr=False)
    server: str | None = None
    max_bars: int = 50_000

    def __repr__(self) -> str:  # never expose secrets
        return f"BridgeConfig(host={self.host!r}, port={self.port}, origins={self.allowed_origins!r}, tz={self.server_timezone!r})"


def from_env(env: dict[str, str] | None = None) -> BridgeConfig:
    e = dict(os.environ if env is None else env)
    token = e.get("TLUXE_BRIDGE_TOKEN", "")
    if len(token) < MIN_TOKEN_LENGTH:
        raise ConfigError(
            f"TLUXE_BRIDGE_TOKEN must be set to a random secret of at least {MIN_TOKEN_LENGTH} characters "
            "(e.g. python -c \"import secrets; print(secrets.token_urlsafe(32))\")."
        )
    host = e.get("TLUXE_BRIDGE_HOST", "127.0.0.1").strip()
    if host in ("0.0.0.0", "::") and e.get("TLUXE_BRIDGE_ALLOW_ALL_INTERFACES") != "1":
        raise ConfigError("Refusing to listen on all interfaces. Bind to 127.0.0.1 or a private address, "
                          "or set TLUXE_BRIDGE_ALLOW_ALL_INTERFACES=1 if you really mean it.")
    origins = tuple(o.strip() for o in e.get("TLUXE_BRIDGE_ALLOWED_ORIGINS", "http://localhost:5180,http://127.0.0.1:5180").split(",") if o.strip())
    login_raw = e.get("TLUXE_MT5_LOGIN", "").strip()
    return BridgeConfig(
        token=token,
        host=host,
        port=int(e.get("TLUXE_BRIDGE_PORT", "8765")),
        allowed_origins=origins,
        server_timezone=(e.get("TLUXE_MT5_SERVER_TIMEZONE") or "").strip() or None,
        terminal_path=(e.get("TLUXE_MT5_TERMINAL_PATH") or "").strip() or None,
        login=int(login_raw) if login_raw else None,
        password=e.get("TLUXE_MT5_PASSWORD") or None,
        server=(e.get("TLUXE_MT5_SERVER") or "").strip() or None,
        max_bars=int(e.get("TLUXE_BRIDGE_MAX_BARS", "50000")),
    )


def mask_login(login: object) -> str:
    s = str(login or "")
    return "****" + s[-3:] if len(s) > 3 else "****"
