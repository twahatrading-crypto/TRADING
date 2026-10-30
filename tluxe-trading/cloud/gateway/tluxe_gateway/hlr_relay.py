"""Read-only relay for the owner's original HLR dashboard (MARKET DATA AND ANALYSIS ONLY).

  Windows PC: MT5 terminal -> mt5_bridge.py :8123 ---+
              IB Gateway  -> gc_hlr engine   :8261 ---+--> bridge/hlr-link (loopback GET only)
              outcome tracker                :8127 ---+        |
                                                               | OUTBOUND wss
   gateway /bridge/hlr (this module)  <--------------------------+
        ^
        | browser GET /api/hlr/<upstream>/<path>   (owner session required)

The PC never accepts an inbound connection, and no credential of any kind reaches the browser.

WHY A SECOND RELAY. The shipped MT5 relay speaks the TLUXE bridge dialect (`/v1/quote/...` on 8765).
The original HLR dashboard speaks its own (`/api/status`, `/api/snapshot`, ...), and its files may not
be edited, so it cannot be re-pointed. This relay carries the HLR dialect on its own namespace. Every
transport property - token auth with SHA-256-only storage, strictly increasing seq + ts, replay and
skew rejection, heartbeats, stale close - is inherited from Mt5Relay rather than rewritten.

THREE RULES THIS FILE ENFORCES.
  1. GET only, positive allowlist, per upstream. Anything not listed is refused here AND on the PC.
  2. The write paths of the HLR bridge - /api/order, /api/trade, /api/position, /api/account/ - and
     the e-mail paths - /api/alert-email, /api/alert-test-email - can never be relayed. The first four
     would place orders; the last two would send a second copy of an alert the PC already sends.
  3. Strict pass-through: the body is handed on exactly as the local engine produced it. Nothing is
     cached, reshaped, merged or back-filled, because `market_status: "LIVE"` from a cached body would
     be a lie. When the link is down the caller gets an error, never a stale body.
"""
from __future__ import annotations

import logging
import re

from .mt5_relay import Mt5Relay, RelayError

log = logging.getLogger("tluxe.gateway.hlr")

#: Loopback services the link may read, named so no URL or port ever reaches the browser.
UPSTREAMS = ("mt5", "gc", "tracker")

_Q = r"(\?[A-Za-z0-9_=&.,%:+-]{0,200})?$"

#: Exactly the paths the dashboard's own files request - nothing wider.
ALLOWED = {
    # mt5_bridge.py :8123 - feed.js, hlr-ui.js, hlr-alerts.js (read-only views only)
    "mt5": re.compile(r"^/api/(status|symbols|tick|history|history-events|engine-status|alert-status"
                      r"|signal-log|signal-log/status|signal-log/export)" + _Q),
    # gc_hlr runtime.py :8261 - hlr-gc.js. The GC analysis itself, computed on the PC.
    "gc": re.compile(r"^/api/snapshot" + _Q),
    # outcomes tracker :8127 - hlr-winloss.js
    "tracker": re.compile(r"^/api/(outcomes|history)" + _Q),
}

#: Belt and braces. These must never match ALLOWED either; if one ever did, this still refuses it.
FORBIDDEN = re.compile(r"^/api/(order|trade|position|account|alert-email|alert-test-email)\b")


def allowed_path(upstream: str, path: str) -> bool:
    """True only for a read-only path of a known upstream. Used by the gateway and mirrored on the PC."""
    if upstream not in ALLOWED:
        return False
    if FORBIDDEN.match(path):
        return False
    return bool(ALLOWED[upstream].match(path))


class HlrRelay(Mt5Relay):
    """The HLR dialect over the same audited transport."""

    OFFLINE = "The HLR link on the trading PC is not connected."
    LABEL = "HLR link"
    LOGGER = log
    #: WHY 120 s AND NOT THE MT5 RELAY'S 30 s. bridge/hlr-link sends its heartbeat only
    #: after probing each local upstream in turn, and link.py allows LOCAL_TIMEOUT_S = 12 s
    #: per probe: 3 upstreams x 12 s + the 10 s sleep = 46 s between heartbeats on a trading
    #: PC whose local services are merely SLOW. At 30 s the gateway would close that healthy
    #: link, which is the one thing this change must not do, so the threshold is set above
    #: TWICE the worst case (92 s) and left finite where today it is infinite. A dead TCP
    #: socket is caught long before this by the WebSocket ping now enabled on /bridge/hlr;
    #: this check is the backstop for a client that is silent but still connected.
    STALE_S = 120

    async def request(self, upstream: str, path: str, timeout: float = 15.0) -> tuple[int, object]:  # type: ignore[override]
        if not allowed_path(upstream, path):
            self.counts["blockedPaths"] += 1
            raise RelayError("FORBIDDEN_PATH",
                             "Only read-only HLR market-data and analysis requests are relayed.", 403)
        ws = self.ws
        if ws is None:
            raise RelayError("BRIDGE_OFFLINE", self.OFFLINE, 503)
        return await self._ask(ws, {"type": "request", "method": "GET",
                                    "upstream": upstream, "path": path}, timeout)

    async def _ask(self, ws, body: dict, timeout: float) -> tuple[int, object]:
        import asyncio
        import json

        rid = next(self.ids)
        fut = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        self.counts["requests"] += 1
        await ws.send_str(json.dumps(self.envelope({**body, "id": rid})))
        try:
            msg = await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            self.pending.pop(rid, None)
            raise RelayError("BRIDGE_TIMEOUT", "The HLR link did not answer in time.", 504) from None
        # Pass-through: the body is exactly what the local engine returned.
        return int(msg.get("status") or 502), msg.get("body")
