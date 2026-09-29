"""Configuration of the TLUXE IBKR depth bridge (runs ON the Windows VPS, next to IB Gateway).

Values come from the environment or `bridge/ibkr/.env` (gitignored). The link token is the ONLY secret here; IBKR
usernames / passwords / 2FA are never read, stored or needed by this process (they are typed into IB Gateway itself).
"""
from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

MIN_TOKEN = 32


class ConfigError(ValueError):
    pass


class Secret:
    __slots__ = ("_v",)

    def __init__(self, v: str) -> None:
        self._v = v

    def reveal(self) -> str:
        return self._v

    def __repr__(self) -> str:
        return "Secret(****)"

    __str__ = __repr__


@dataclass(frozen=True)
class BridgeConfig:
    gateway_url: str
    link_token: Secret = field(repr=False)
    ib_host: str = "127.0.0.1"
    ib_port: int = 4001  # IB Gateway live default (paper: 4002)
    client_id: int = 71
    rows: int = 10
    roots: tuple[str, ...] = ("GC", "SI")
    bridge_id: str = "ibkr-vps"
    gateway_process: str = "ibgateway.exe"


def _loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def load_env_file(path: Path, into: dict) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in into:
            into[k] = v


def load_config(env: dict | None = None, env_file: Path | None = None) -> BridgeConfig:
    e = dict(os.environ if env is None else env)
    if env_file is not None:
        load_env_file(env_file, e)
    url = (e.get("TLUXE_IBKR_GATEWAY_URL") or "").strip()
    u = urlparse(url)
    if u.scheme not in ("wss", "ws") or not u.hostname:
        raise ConfigError("TLUXE_IBKR_GATEWAY_URL must be wss://<your TLUXE cloud host>/bridge/ibkr")
    if u.scheme == "ws" and not _loopback(u.hostname):
        raise ConfigError("TLUXE_IBKR_GATEWAY_URL must use wss:// (plain ws:// only to a loopback test gateway)")
    token = e.get("TLUXE_IBKR_BRIDGE_TOKEN") or ""
    if len(token) < MIN_TOKEN:
        raise ConfigError(f"TLUXE_IBKR_BRIDGE_TOKEN must be at least {MIN_TOKEN} characters (the cloud stores only its SHA-256)")
    host = (e.get("TLUXE_IBKR_HOST") or "127.0.0.1").strip()
    if not _loopback(host):
        raise ConfigError("TLUXE_IBKR_HOST must be loopback: IB Gateway runs on this VPS and its API is never exposed")
    try:
        port = int(e.get("TLUXE_IBKR_PORT") or 4001)
        client_id = int(e.get("TLUXE_IBKR_CLIENT_ID") or 71)
        rows = int(e.get("TLUXE_IBKR_DEPTH_ROWS") or 10)
    except ValueError as err:
        raise ConfigError(f"numeric setting invalid: {err}") from None
    if not 1 <= rows <= 50:
        raise ConfigError("TLUXE_IBKR_DEPTH_ROWS must be 1..50")
    roots = tuple(r.strip().upper() for r in (e.get("TLUXE_IBKR_ROOTS") or "GC,SI").split(",") if r.strip())
    if not roots or any(r not in ("GC", "SI") for r in roots):
        raise ConfigError("TLUXE_IBKR_ROOTS must be GC and/or SI")
    return BridgeConfig(gateway_url=url, link_token=Secret(token), ib_host=host, ib_port=port, client_id=client_id, rows=rows,
                        roots=roots, bridge_id=(e.get("TLUXE_IBKR_BRIDGE_ID") or "ibkr-vps")[:64],
                        gateway_process=e.get("TLUXE_IBKR_GATEWAY_PROCESS") or "ibgateway.exe")
