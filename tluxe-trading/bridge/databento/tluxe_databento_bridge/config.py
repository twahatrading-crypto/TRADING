"""Bridge configuration from environment variables / a local .env file.

The Databento API key is read from DATABENTO_API_KEY ONLY, kept in a `Secret` wrapper that never prints its
value, and is never logged, never returned by an endpoint and never sent to the browser. The bridge refuses to
start (fails closed) when the key or the bridge token is missing.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

MIN_TOKEN_LENGTH = 32
DATASET = "GLBX.MDP3"
ROOTS = ("GC", "SI")
# Databento continuous-contract symbology: `.v.0` = the contract with the highest volume (resolved by Databento).
AUTO_SYMBOL = {"GC": "GC.v.0", "SI": "SI.v.0"}
RAW_CONTRACT_RE = re.compile(r"^(GC|SI)[FGHJKMNQUVXZ]\d{1,2}$")


class ConfigError(ValueError):
    """Configuration problem. Messages NEVER contain secret values."""


class Secret:
    """Holds a secret string; repr/str never reveal it."""

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
class BridgeConfig:
    api_key: Secret = field(repr=False)
    token: Secret = field(repr=False)
    host: str = "127.0.0.1"
    port: int = 8766
    allowed_origins: tuple[str, ...] = ("http://localhost:5181", "http://127.0.0.1:5181", "http://localhost:4181", "http://127.0.0.1:4181")
    contract_mode: str = "auto"
    manual_contracts: dict = field(default_factory=dict)
    max_trades: int = 100_000
    max_frames: int = 1200
    publish_ms: int = 250
    replay_hours: int = 24
    # Freshness rules (see README): no Databento message (data or heartbeat) for stale_ms -> STALE;
    # ingest lag (now - ts_recv of the newest processed record) above lag_ms -> DEGRADED (consumer behind).
    heartbeat_s: int = 10
    stale_ms: int = 25_000
    lag_ms: int = 5_000

    def symbol_for(self, root: str) -> tuple[str, str]:
        """(symbol, stype_in) subscribed for a root. Manual mode keeps the provider design unchanged."""
        if self.contract_mode == "manual":
            return self.manual_contracts[root], "raw_symbol"
        return AUTO_SYMBOL[root], "continuous"

    def __repr__(self) -> str:  # never expose secrets
        return f"BridgeConfig(host={self.host!r}, port={self.port}, origins={self.allowed_origins!r}, mode={self.contract_mode!r})"


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


def from_env(env: dict | None = None) -> BridgeConfig:
    e = dict(os.environ if env is None else env)
    key = (e.get("DATABENTO_API_KEY") or "").strip()
    if not key:
        raise ConfigError("DATABENTO_API_KEY is not set. Put it in bridge/databento/.env (gitignored) or the environment. The bridge will not start without it.")
    token = e.get("TLUXE_DB_BRIDGE_TOKEN", "")
    if len(token) < MIN_TOKEN_LENGTH:
        raise ConfigError(f"TLUXE_DB_BRIDGE_TOKEN must be a random secret of at least {MIN_TOKEN_LENGTH} characters "
                          "(python -c \"import secrets; print(secrets.token_urlsafe(32))\").")
    if token == key:
        raise ConfigError("TLUXE_DB_BRIDGE_TOKEN must not be the Databento API key (the bridge token is given to the browser).")
    host = e.get("TLUXE_DB_BRIDGE_HOST", "127.0.0.1").strip()
    if host in ("0.0.0.0", "::") and e.get("TLUXE_DB_BRIDGE_ALLOW_ALL_INTERFACES") != "1":
        raise ConfigError("Refusing to listen on all interfaces. Bind to 127.0.0.1 or a private address.")
    origins = tuple(o.strip() for o in e.get("TLUXE_DB_BRIDGE_ALLOWED_ORIGINS", ",".join(BridgeConfig.allowed_origins)).split(",") if o.strip())
    mode = (e.get("TLUXE_DB_CONTRACT_MODE") or "auto").strip().lower()
    if mode not in ("auto", "manual"):
        raise ConfigError("TLUXE_DB_CONTRACT_MODE must be 'auto' or 'manual'")
    manual: dict[str, str] = {}
    if mode == "manual":
        for root in ROOTS:
            c = (e.get(f"TLUXE_DB_CONTRACT_{root}") or "").strip().upper()
            if not RAW_CONTRACT_RE.match(c) or not c.startswith(root):
                raise ConfigError(f"Manual mode needs TLUXE_DB_CONTRACT_{root} set to a raw {root} contract such as {root}Z6")
            manual[root] = c
    return BridgeConfig(
        api_key=Secret(key),
        token=Secret(token),
        host=host,
        port=_int(e, "TLUXE_DB_BRIDGE_PORT", 8766, 1, 65535),
        allowed_origins=origins,
        contract_mode=mode,
        manual_contracts=manual,
        max_trades=_int(e, "TLUXE_DB_MAX_TRADES", 100_000, 1_000, 2_000_000),
        max_frames=_int(e, "TLUXE_DB_MAX_FRAMES", 1200, 60, 20_000),
        publish_ms=_int(e, "TLUXE_DB_PUBLISH_MS", 250, 50, 5000),
        replay_hours=_int(e, "TLUXE_DB_REPLAY_HOURS", 24, 0, 24),
    )
