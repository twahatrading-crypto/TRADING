"""IB Gateway API adapter - the ONLY module that imports IBKR's official Python API (`ibapi`, from the TWS API
download: IBJts/source/pythonclient -> `pip install .`). MARKET DATA ONLY: this class never calls any order-entry,
account / order / position method, and IB Gateway should additionally run with "Read-Only API" enabled.

Threading: EClient.run() blocks, so it runs in a worker thread; every callback is marshalled onto the asyncio loop
(`call_soon_threadsafe`) and handled by the single-threaded DepthSession.
"""
from __future__ import annotations

import asyncio
import logging
import subprocess
import sys
import threading

from .contracts import EXCHANGE, CURRENCY, Resolved

log = logging.getLogger("tluxe.ibkr.api")


def gateway_process_running(name: str) -> bool | None:
    """True / False when the OS can tell, None otherwise (non-Windows or tasklist unavailable)."""
    if sys.platform != "win32":
        return None
    try:
        out = subprocess.run(["tasklist", "/FI", f"IMAGENAME eq {name}", "/NH"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return None
    return name.lower() in out.lower()


def _details_dict(cd) -> dict:
    c = cd.contract
    return {"conId": c.conId, "symbol": c.symbol, "localSymbol": c.localSymbol, "secType": c.secType, "exchange": c.exchange,
            "currency": c.currency, "tradingClass": c.tradingClass, "multiplier": c.multiplier,
            "lastTradeDateOrContractMonth": c.lastTradeDateOrContractMonth, "minTick": getattr(cd, "minTick", 0)}


class IbAdapter:
    """Implements session.Api and forwards IB callbacks to a DepthSession on the event loop."""

    def __init__(self, loop: asyncio.AbstractEventLoop, session, host: str, port: int, client_id: int) -> None:
        from ibapi.client import EClient  # official IBKR API - imported here only
        from ibapi.wrapper import EWrapper

        self.loop, self.session, self.host, self.port, self.client_id = loop, session, host, port, client_id
        adapter = self

        class App(EWrapper, EClient):
            def __init__(self) -> None:
                EWrapper.__init__(self)
                EClient.__init__(self, wrapper=self)

            def _post(self, fn, *a) -> None:
                adapter.loop.call_soon_threadsafe(fn, *a)

            def nextValidId(self, orderId: int) -> None:  # noqa: N802 - IBKR callback names
                self._post(adapter._on_ready)

            def connectionClosed(self) -> None:  # noqa: N802
                self._post(adapter._on_closed, "IB Gateway closed the API connection")

            def error(self, *args) -> None:  # signature differs between API versions: (reqId, [errorTime,] code, msg, ...)
                req_id = int(args[0]) if args else -1
                nums = [a for a in args[1:] if isinstance(a, int)]
                strs = [a for a in args[1:] if isinstance(a, str)]
                code = nums[-1] if nums else -1
                if len(nums) >= 2:  # (reqId, errorTime, errorCode, ...)
                    code = nums[1]
                self._post(adapter.session.on_error, req_id, code, strs[0] if strs else "")

            def contractDetails(self, reqId: int, contractDetails) -> None:  # noqa: N802
                self._post(adapter.session.on_contract_details, reqId, _details_dict(contractDetails))

            def contractDetailsEnd(self, reqId: int) -> None:  # noqa: N802
                self._post(adapter.session.on_contract_details_end, reqId)

            def updateMktDepth(self, reqId, position, operation, side, price, size) -> None:  # noqa: N802
                self._post(adapter.session.on_depth, reqId, position, operation, side, float(price), float(size), "")

            def updateMktDepthL2(self, reqId, position, marketMaker, operation, side, price, size, isSmartDepth=False) -> None:  # noqa: N802
                self._post(adapter.session.on_depth, reqId, position, operation, side, float(price), float(size), str(marketMaker or ""))

            def currentTime(self, time_: int) -> None:  # noqa: N802
                self._post(adapter.session.on_ib_heartbeat)

        self.app = App()
        self.thread: threading.Thread | None = None
        self.ready = asyncio.Event()
        self.closed = asyncio.Event()

    # ---------------------------------------------------------------- lifecycle
    async def connect(self, timeout: float = 15) -> None:
        self.ready.clear()
        self.closed.clear()
        await asyncio.to_thread(self.app.connect, self.host, self.port, self.client_id)
        if not self.app.isConnected():
            raise ConnectionError(f"IB Gateway API not reachable on {self.host}:{self.port}")
        self.thread = threading.Thread(target=self.app.run, name="ibapi", daemon=True)
        self.thread.start()
        await asyncio.wait_for(self.ready.wait(), timeout)

    def _on_ready(self) -> None:
        if not self.ready.is_set():
            self.ready.set()
            self.session.on_connected(self.app.serverVersion())

    def _on_closed(self, why: str) -> None:
        self.closed.set()

    def heartbeat(self) -> None:
        if self.app.isConnected():
            self.app.reqCurrentTime()

    def disconnect(self) -> None:
        try:
            self.app.disconnect()
        except Exception:
            pass

    # ---------------------------------------------------------------- session.Api
    def request_contract(self, req_id: int, root: str, local_symbol: str) -> None:
        from ibapi.contract import Contract

        c = Contract()
        c.secType, c.symbol, c.localSymbol, c.exchange, c.currency = "FUT", root, local_symbol, EXCHANGE, CURRENCY
        self.app.reqContractDetails(req_id, c)

    def request_depth(self, req_id: int, r: Resolved, rows: int) -> None:
        from ibapi.contract import Contract

        c = Contract()
        c.conId, c.exchange = r.con_id, EXCHANGE  # DIRECT COMEX depth - not SMART aggregation
        self.app.reqMktDepth(req_id, c, rows, False, [])

    def cancel_depth(self, req_id: int) -> None:
        if self.app.isConnected():
            self.app.cancelMktDepth(req_id, False)
