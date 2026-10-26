"""TLUXE HLR link - runs on the Windows trading PC.

It lets the TLUXE cloud gateway read the ALREADY-RUNNING local HLR services without any inbound port:
it dials out over WSS to wss://<domain>/bridge/hlr and answers read-only GET requests.

  MT5 terminal -> mt5_bridge.py   127.0.0.1:8123   ("mt5")
  IB Gateway   -> gc_hlr engine   127.0.0.1:8261   ("gc")
  outcome tracker                 127.0.0.1:8127   ("tracker")

WHAT IT IS NOT. It does not open an MT5 connection, an IBKR client, a collector, a runner or a mailer.
It only performs HTTP GETs against services that are already running, over loopback, so it can never
create a duplicate broker subscription or a second copy of an alert.

READ-ONLY, TWICE. Only GET, and only the paths in ALLOWED below - checked here as well as in the
cloud. The HLR bridge's write paths (/api/order, /api/trade, /api/position, /api/account/) and its
e-mail paths (/api/alert-email, /api/alert-test-email) are refused and can never be reached.

SECURITY. The link authenticates with TLUXE_HLR_BRIDGE_TOKEN (>= 32 characters); the cloud stores only
its SHA-256. Every message carries a strictly increasing seq and a ts; replays, out-of-order messages
and timestamps more than +/-30 s out are rejected. Every upstream must be loopback - the local
services are never exposed. Nothing is ever written to disk about the data that passes through.

Run:  start_hlr_link.cmd       (creates .venv, installs websockets, starts the link)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

log = logging.getLogger("tluxe.hlr.link")

MIN_TOKEN = 32
MAX_SKEW_MS = 30_000
STALE_S = 45
HEARTBEAT_S = 10
AUTH_BACKOFF_S = 300
LOCAL_TIMEOUT_S = 12.0

#: Default loopback bases. Overridable per upstream, but always validated as loopback.
DEFAULT_UPSTREAMS = {
    "mt5": "http://127.0.0.1:8123",
    "gc": "http://127.0.0.1:8261",
    "tracker": "http://127.0.0.1:8127",
}

_Q = r"(\?[A-Za-z0-9_=&.,%:+-]{0,200})?$"
#: Mirrors cloud/gateway/tluxe_gateway/hlr_relay.py - keep the two in step.
ALLOWED = {
    "mt5": re.compile(r"^/api/(status|symbols|tick|history|history-events|engine-status|alert-status"
                      r"|signal-log|signal-log/status|signal-log/export)" + _Q),
    "gc": re.compile(r"^/api/snapshot" + _Q),
    "tracker": re.compile(r"^/api/(outcomes|history)" + _Q),
}
FORBIDDEN = re.compile(r"^/api/(order|trade|position|account|alert-email|alert-test-email)\b")


class LinkConfigError(Exception):
    pass


class Secret:
    """Keeps the token out of logs, reprs and tracebacks."""

    __slots__ = ("_v",)

    def __init__(self, v: str) -> None:
        self._v = v

    def reveal(self) -> str:
        return self._v

    def __repr__(self) -> str:  # pragma: no cover - defensive
        return "<Secret>"


def allowed_path(upstream: str, path: str) -> bool:
    if upstream not in ALLOWED or FORBIDDEN.match(path):
        return False
    return bool(ALLOWED[upstream].match(path))


def is_loopback(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in ("127.0.0.1", "localhost", "::1")


class LinkConfig:
    def __init__(self, gateway_url: str, token: Secret, bridge_id: str, upstreams: dict[str, str]) -> None:
        self.gateway_url, self.token, self.bridge_id, self.upstreams = gateway_url, token, bridge_id, upstreams


def load_env_file(path: Path, into: dict) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            into.setdefault(k.strip(), v.strip())


def from_env(env: dict) -> LinkConfig:
    url = (env.get("TLUXE_HLR_GATEWAY_URL") or "").strip()
    if not url.startswith("wss://"):
        raise LinkConfigError("TLUXE_HLR_GATEWAY_URL must be a wss:// URL (the link never sends data in clear text)")
    token = (env.get("TLUXE_HLR_BRIDGE_TOKEN") or "").strip()
    if len(token) < MIN_TOKEN:
        raise LinkConfigError(f"TLUXE_HLR_BRIDGE_TOKEN must be at least {MIN_TOKEN} characters")
    bridge_id = (env.get("TLUXE_HLR_BRIDGE_ID") or "hlr-pc").strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", bridge_id):
        raise LinkConfigError("TLUXE_HLR_BRIDGE_ID must be 1-64 of letters, digits, . _ -")
    upstreams = dict(DEFAULT_UPSTREAMS)
    for name in upstreams:
        override = (env.get(f"TLUXE_HLR_{name.upper()}_URL") or "").strip().rstrip("/")
        if override:
            upstreams[name] = override
        if not is_loopback(upstreams[name]):
            raise LinkConfigError(f"the {name} upstream must be a loopback address - local services are never exposed")
    return LinkConfig(url, Secret(token), bridge_id, upstreams)


def local_get(cfg: LinkConfig, upstream: str, path: str, timeout: float = LOCAL_TIMEOUT_S) -> tuple[int, object]:
    """GET one already-running local service over loopback. Never called for a non-allowlisted path."""
    url = cfg.upstreams[upstream] + path
    req = urllib.request.Request(url, method="GET", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - loopback, validated above
            raw = r.read()
            try:
                return r.status, json.loads(raw)
            except ValueError:
                return r.status, {"error": {"code": "NOT_JSON", "message": "upstream did not return JSON"}}
    except urllib.error.HTTPError as e:
        return e.code, {"error": {"code": "UPSTREAM_HTTP", "message": f"{upstream} answered HTTP {e.code}"}}
    except Exception as e:  # noqa: BLE001 - the service may simply not be running
        return 503, {"error": {"code": "UPSTREAM_OFFLINE",
                               "message": f"{upstream} is not reachable on this PC ({type(e).__name__})"}}


class Link:
    def __init__(self, cfg: LinkConfig, connect=None, local=local_get, clock=time.time,
                 sleep=asyncio.sleep, rand=random.random) -> None:
        self.cfg, self._connect, self.local = cfg, connect, local
        self.clock, self._sleep, self.rand = clock, sleep, rand
        self.stopped = asyncio.Event()
        self.state = "INIT"
        self.tx_seq = self.rx_seq = 0
        self.counts = {"connects": 0, "requests": 0, "refused": 0, "rejected": 0, "authFailures": 0}

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
        rid = msg.get("id")
        method = msg.get("method")
        upstream = str(msg.get("upstream") or "")
        path = str(msg.get("path") or "")
        if method != "GET" or not allowed_path(upstream, path):
            self.counts["refused"] += 1
            await ws.send(self.env({"type": "response", "id": rid, "status": 403,
                                    "body": {"error": {"code": "READ_ONLY",
                                                       "message": "Only read-only HLR market data and analysis are served."}}}))
            return
        self.counts["requests"] += 1
        status, body = await asyncio.get_running_loop().run_in_executor(
            None, self.local, self.cfg, upstream, path)
        await ws.send(self.env({"type": "response", "id": rid, "status": status, "body": body}))

    async def _heartbeats(self, ws) -> None:
        """Report which local services are answering - never what they returned."""
        while True:
            health = {}
            for name in self.cfg.upstreams:
                probe = "/api/snapshot" if name == "gc" else ("/api/outcomes" if name == "tracker" else "/api/status")
                status, _ = await asyncio.get_running_loop().run_in_executor(
                    None, self.local, self.cfg, name, probe)
                health[name] = {"reachable": status == 200, "status": status}
            await ws.send(self.env({"type": "heartbeat", "health": health}))
            await asyncio.sleep(HEARTBEAT_S)

    async def session(self) -> str:
        """One connection lifetime. Returns 'stop' | 'auth' | 'reconnect'."""
        if self._connect is None:
            from websockets.asyncio.client import connect as ws_connect

            self._connect = lambda url, headers: ws_connect(
                url, additional_headers=headers, open_timeout=15, ping_interval=20,
                ping_timeout=20, max_size=4_000_000)
        headers = {"Authorization": f"Bearer {self.cfg.token.reveal()}",
                   "X-TLUXE-Bridge-Id": self.cfg.bridge_id}
        self.state = "CONNECTING"
        try:
            ws = await self._connect(self.cfg.gateway_url, headers)
        except Exception as exc:  # noqa: BLE001
            code = getattr(getattr(exc, "response", None), "status_code", None)
            if code in (401, 403):
                self.counts["authFailures"] += 1
                log.error("gateway rejected the HLR link credential (HTTP %s) - check TLUXE_HLR_BRIDGE_TOKEN", code)
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


def main() -> None:  # pragma: no cover - entry point
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    env = dict(os.environ)
    load_env_file(Path(__file__).with_name(".env"), env)
    asyncio.run(Link(from_env(env)).run())


if __name__ == "__main__":  # pragma: no cover
    main()
