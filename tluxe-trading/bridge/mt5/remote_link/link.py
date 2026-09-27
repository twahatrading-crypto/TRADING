"""TLUXE MT5 remote link - runs on the Windows VPS next to MT5 and the local TLUXE MT5 bridge.

  MT5 terminal -> local bridge (127.0.0.1:8765, local token) <- THIS link -- OUTBOUND wss --> TLUXE cloud gateway

READ-ONLY market data. The link:
  * opens ONE outbound WSS connection (no inbound port on the VPS), authenticated with TLUXE_MT5_BRIDGE_TOKEN
    (the cloud stores only its SHA-256; rotate by adding the new hash, switching the VPS, removing the old hash);
  * answers only GET requests on the read-only allowlist by calling the LOCAL bridge (loopback only) with the local
    token - which never leaves the VPS; anything else is refused without touching MT5;
  * numbers every message (seq) with a timestamp and rejects replayed / out-of-order / skewed gateway messages;
  * sends a heartbeat (with the local bridge's terminal status) every 10 s; no gateway message for 45 s = stale ->
    reconnect; reconnects with jittered exponential back-off (2 s -> 60 s); a rejected credential backs off 5 min.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import random
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

log = logging.getLogger("tluxe.mt5.link")
READ_ONLY_PATH = re.compile(r"^/v1/(health|symbols|symbol/[A-Za-z0-9._#%-]{1,64}|quote/[A-Za-z0-9._#%-]{1,64}|rates/[A-Za-z0-9._#%-]{1,64})(\?[A-Za-z0-9_=&.%-]{0,200})?$")
HEARTBEAT_S = 10
STALE_S = 45
MAX_SKEW_MS = 30_000
AUTH_BACKOFF_S = 300
MIN_TOKEN = 32


class LinkConfigError(ValueError):
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
class LinkConfig:
    gateway_url: str
    remote_token: Secret = field(repr=False)
    local_url: str
    local_token: Secret = field(repr=False)
    bridge_id: str = "mt5-vps"


def _loopback(url: str) -> bool:
    host = urlparse(url).hostname or ""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def load_env_file(path: Path, into: dict) -> None:
    if path.is_file():
        for raw in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            line = raw.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                into.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def from_env(env: dict) -> LinkConfig:
    url = (env.get("TLUXE_GATEWAY_BRIDGE_URL") or "").strip()
    p = urlparse(url)
    if p.scheme != "wss" and not (p.scheme == "ws" and _loopback(url) and env.get("TLUXE_LINK_ALLOW_INSECURE_LOCAL") == "1"):
        raise LinkConfigError("TLUXE_GATEWAY_BRIDGE_URL must be wss://<your TLUXE domain>/bridge/mt5 (TLS required)")
    if not p.path.endswith("/bridge/mt5"):
        raise LinkConfigError("TLUXE_GATEWAY_BRIDGE_URL must end with /bridge/mt5")
    remote = (env.get("TLUXE_MT5_BRIDGE_TOKEN") or "").strip()
    local = (env.get("TLUXE_BRIDGE_TOKEN") or "").strip()
    if len(remote) < MIN_TOKEN:
        raise LinkConfigError(f"TLUXE_MT5_BRIDGE_TOKEN must be at least {MIN_TOKEN} characters")
    if not local:
        raise LinkConfigError("TLUXE_BRIDGE_TOKEN (the local MT5 bridge token from bridge/mt5/.env) is required")
    if remote == local:
        raise LinkConfigError("TLUXE_MT5_BRIDGE_TOKEN must differ from the local bridge token")
    local_url = (env.get("TLUXE_LOCAL_BRIDGE_URL") or "http://127.0.0.1:8765").strip().rstrip("/")
    if not _loopback(local_url):
        raise LinkConfigError("TLUXE_LOCAL_BRIDGE_URL must be a loopback address (the MT5 bridge is never exposed)")
    bid = (env.get("TLUXE_BRIDGE_ID") or "mt5-vps").strip()
    if not re.match(r"^[A-Za-z0-9._-]{1,64}$", bid):
        raise LinkConfigError("TLUXE_BRIDGE_ID must be 1-64 letters, digits, . _ -")
    return LinkConfig(url, Secret(remote), local_url, Secret(local), bid)


def local_get(cfg: LinkConfig, path: str, timeout: float = 12.0) -> tuple[int, object]:
    """GET the LOCAL bridge (loopback) with the local token. Never called for a non-allowlisted path."""
    req = urllib.request.Request(f"{cfg.local_url}{path}", headers={"Authorization": f"Bearer {cfg.local_token.reveal()}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - loopback only (validated)
            return r.status, json.loads(r.read().decode("utf-8", errors="replace") or "null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8", errors="replace") or "null")
        except ValueError:
            return e.code, None
    except (OSError, ValueError):
        return 502, {"error": {"code": "MT5_BRIDGE_OFFLINE", "message": "Local MT5 bridge not reachable on the VPS."}}


class Link:
    def __init__(self, cfg: LinkConfig, connect=None, local=local_get, clock=time.time, sleep=asyncio.sleep, rand=random.random) -> None:
        self.cfg = cfg
        self._connect = connect
        self.local = local
        self.clock = clock
        self._sleep = sleep
        self.rand = rand
        self.tx_seq = 0
        self.rx_seq = 0
        self.stopped = asyncio.Event()
        self.counts = {"connects": 0, "requests": 0, "refused": 0, "rejected": 0, "authFailures": 0}
        self.state = "IDLE"

    def now_ms(self) -> int:
        return int(self.clock() * 1000)

    def env(self, body: dict) -> str:
        self.tx_seq += 1
        return json.dumps({**body, "seq": self.tx_seq, "ts": self.now_ms()})

    def validate(self, msg: dict) -> str | None:
        seq, ts = msg.get("seq"), msg.get("ts")
        if not isinstance(seq, int) or not isinstance(ts, int):
            return "MALFORMED"
        if abs(ts - self.now_ms()) > MAX_SKEW_MS:
            return "TIMESTAMP_SKEW"
        if seq <= self.rx_seq:
            return "REPLAY_OR_OUT_OF_ORDER"
        self.rx_seq = seq
        return None

    async def handle(self, ws, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        if not isinstance(msg, dict):
            return
        why = self.validate(msg)
        if why:
            self.counts["rejected"] += 1
            log.warning("gateway message rejected: %s", why)
            return
        if msg.get("type") != "request":
            return
        rid, method, path = msg.get("id"), msg.get("method"), str(msg.get("path") or "")
        if method != "GET" or not READ_ONLY_PATH.match(path):
            self.counts["refused"] += 1
            await ws.send(self.env({"type": "response", "id": rid, "status": 403, "body": {"error": {"code": "READ_ONLY", "message": "Only read-only market data is served."}}}))
            return
        self.counts["requests"] += 1
        status, body = await asyncio.get_running_loop().run_in_executor(None, self.local, self.cfg, path)
        await ws.send(self.env({"type": "response", "id": rid, "status": status, "body": body}))

    async def _heartbeats(self, ws) -> None:
        while True:
            status, h = await asyncio.get_running_loop().run_in_executor(None, self.local, self.cfg, "/v1/health")
            health = {"terminal": (h or {}).get("terminal"), "error": (h or {}).get("error"), "bridge": (h or {}).get("bridge")} if status == 200 and isinstance(h, dict) \
                else {"terminal": {"state": "BRIDGE_OFFLINE"}, "error": {"code": "MT5_BRIDGE_OFFLINE"}}
            await ws.send(self.env({"type": "heartbeat", "health": health}))
            await asyncio.sleep(HEARTBEAT_S)

    async def session(self) -> str:
        """One connection lifetime. Returns 'stop' | 'auth' | 'reconnect'."""
        if self._connect is None:
            from websockets.asyncio.client import connect as ws_connect

            self._connect = lambda url, headers: ws_connect(url, additional_headers=headers, open_timeout=15, ping_interval=20, ping_timeout=20, max_size=4_000_000)
        headers = {"Authorization": f"Bearer {self.cfg.remote_token.reveal()}", "X-TLUXE-Bridge-Id": self.cfg.bridge_id}
        self.state = "CONNECTING"
        try:
            ws = await self._connect(self.cfg.gateway_url, headers)
        except Exception as exc:  # noqa: BLE001
            code = getattr(getattr(exc, "response", None), "status_code", None)
            if code in (401, 403):
                self.counts["authFailures"] += 1
                log.error("TLUXE gateway rejected the MT5 bridge credential (HTTP %s) - check TLUXE_MT5_BRIDGE_TOKEN", code)
                return "auth"
            log.warning("cannot reach the TLUXE gateway (%s)", type(exc).__name__)
            return "reconnect"
        self.counts["connects"] += 1
        self.tx_seq = self.rx_seq = 0
        self.state = "CONNECTED"
        log.info("connected to the TLUXE gateway as %s", self.cfg.bridge_id)
        hb = asyncio.create_task(self._heartbeats(ws))
        try:
            await ws.send(self.env({"type": "hello", "bridgeId": self.cfg.bridge_id, "readOnly": True}))
            while not self.stopped.is_set():
                try:
                    raw = await asyncio.wait_for(ws.recv(), STALE_S)
                except asyncio.TimeoutError:
                    log.warning("no gateway message for %d s - reconnecting", STALE_S)
                    return "reconnect"
                await self.handle(ws, raw)
            return "stop"
        except Exception as exc:  # noqa: BLE001 - connection dropped
            log.warning("gateway connection lost (%s)", type(exc).__name__)
            return "reconnect"
        finally:
            hb.cancel()
            self.state = "DISCONNECTED"
            try:
                await ws.close()
            except Exception:
                pass

    async def run(self) -> None:
        backoff = 2.0
        while not self.stopped.is_set():
            started = self.clock()
            why = await self.session()
            if why == "stop" or self.stopped.is_set():
                break
            if why == "auth":
                await self._sleep(AUTH_BACKOFF_S)
                continue
            if self.clock() - started > 120:
                backoff = 2.0
            await self._sleep(backoff * (0.5 + self.rand()))
            backoff = min(60.0, backoff * 2)


def main() -> int:
    import signal
    import sys

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    here = Path(__file__).resolve().parent
    env = dict(os.environ)
    load_env_file(here / ".env", env)
    load_env_file(here.parent / ".env", env)  # the local bridge's TLUXE_BRIDGE_TOKEN
    try:
        cfg = from_env(env)
    except LinkConfigError as exc:
        log.error("%s", exc)
        return 2
    secrets = [cfg.remote_token.reveal(), cfg.local_token.reveal()]

    class _Redact(logging.Filter):
        def filter(self, r: logging.LogRecord) -> bool:
            msg = r.getMessage()
            for s in secrets:
                msg = msg.replace(s, "****")
            r.msg, r.args = msg, ()
            return True

    for h in logging.getLogger().handlers:
        h.addFilter(_Redact())
    logging.getLogger("websockets").setLevel(logging.WARNING)
    link = Link(cfg)
    loop = asyncio.new_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, link.stopped.set)
        except (NotImplementedError, RuntimeError):  # Windows: Ctrl+C raises KeyboardInterrupt instead
            pass
    log.info("TLUXE MT5 remote link %s -> %s (read-only)", cfg.bridge_id, urlparse(cfg.gateway_url).netloc)
    try:
        loop.run_until_complete(link.run())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
