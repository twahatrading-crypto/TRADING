"""TLUXE IBKR depth bridge - run on the Windows VPS: `python -m tluxe_ibkr_bridge` (see bridge/ibkr/README.md).

  IB Gateway (127.0.0.1, this VPS) --TWS API--> THIS bridge --outbound wss--> TLUXE cloud gateway (/bridge/ibkr)
"""
from __future__ import annotations

import asyncio
import logging
import sys
import time
from pathlib import Path

from .config import ConfigError, load_config
from .link import GatewayLink, backoff_s
from .session import DepthSession

log = logging.getLogger("tluxe.ibkr")
IB_HEARTBEAT_S = 10
IB_SILENT_S = 35  # no reply to reqCurrentTime for this long -> the API socket is dead: reconnect


class ApiProxy:
    """session.Api that forwards to the current IbAdapter (a new adapter per IB Gateway connection)."""

    def __init__(self) -> None:
        self.adapter = None

    def request_contract(self, *a) -> None:
        if self.adapter:
            self.adapter.request_contract(*a)

    def request_depth(self, *a) -> None:
        if self.adapter:
            self.adapter.request_depth(*a)

    def cancel_depth(self, *a) -> None:
        if self.adapter:
            self.adapter.cancel_depth(*a)


async def ib_loop(cfg, session: DepthSession, api: ApiProxy) -> None:
    from .ib_adapter import IbAdapter, gateway_process_running

    attempt = 0
    while True:
        session.on_connecting()
        adapter = IbAdapter(asyncio.get_running_loop(), session, cfg.ib_host, cfg.ib_port, cfg.client_id)
        api.adapter = adapter
        try:
            await adapter.connect()
            attempt = 0
            log.info("IB Gateway API connected on %s:%d", cfg.ib_host, cfg.ib_port)
            while not adapter.closed.is_set():
                adapter.heartbeat()
                await asyncio.sleep(IB_HEARTBEAT_S)
                hb = session.last_ib_heartbeat_s
                if hb is not None and time.time() - hb > IB_SILENT_S:
                    log.warning("IB Gateway API silent for %d s - reconnecting", IB_SILENT_S)
                    break
            why = "IB Gateway API connection closed"
        except Exception as e:  # noqa: BLE001
            why = f"IB Gateway API not reachable ({type(e).__name__})"
        adapter.disconnect()
        api.adapter = None
        running = gateway_process_running(cfg.gateway_process)
        # IB Gateway running but its API refuses connections = it is sitting at the login screen (daily restart
        # without auto-login, or the weekly re-authentication). We never log in on the user's behalf.
        auth_required = running is True
        if auth_required:
            why = "IB Gateway is running but its API is not accepting connections - IBKR login / 2FA required on the VPS"
        elif running is False:
            why = "IB Gateway is not running on the VPS"
        attempt += 1
        wait = backoff_s(attempt)
        session.on_disconnected(why, auth_required=auth_required, next_retry_s=time.time() + wait)
        log.warning("%s - retry in %.0f s", why, wait)
        await asyncio.sleep(wait)


async def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        cfg = load_config(env_file=Path(__file__).resolve().parent.parent / ".env")
    except ConfigError as e:
        log.error("configuration: %s", e)
        return 2
    api = ApiProxy()
    link_ref: dict = {}
    session = DepthSession(api, lambda m: link_ref["link"].send(m), roots=cfg.roots, rows=cfg.rows)

    def on_gateway(msg: dict) -> None:
        if msg.get("type") == "targets" and isinstance(msg.get("roots"), dict):
            session.on_targets(msg["roots"])
        elif msg.get("type") == "snapshot" and isinstance(msg.get("root"), str):
            snap = session.snapshot(msg["root"])
            if snap:
                link.send(snap)

    async def on_link_connected() -> None:
        link.send({"type": "health", **session.health()})
        for root in cfg.roots:  # the gateway may have restarted: give it the authoritative current books
            snap = session.snapshot(root)
            if snap:
                link.send(snap)

    link = GatewayLink(cfg.gateway_url, cfg.link_token, cfg.bridge_id, on_gateway, on_link_connected)
    link_ref["link"] = link

    async def periodic() -> None:
        n = 0
        while True:
            await asyncio.sleep(0.1)
            session.flush()
            n += 1
            if n % 10 == 0:
                session.tick()
            if n % 50 == 0:
                link.send({"type": "health", **session.health()})

    await asyncio.gather(link.run_forever(), ib_loop(cfg, session, api), periodic())
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
