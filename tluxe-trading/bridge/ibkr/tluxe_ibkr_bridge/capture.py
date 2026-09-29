"""Evidence capture: record exactly what IBKR market depth delivers for GC / SI (run ON the VPS, IB Gateway logged in).

  python -m tluxe_ibkr_bridge.capture --gc GCZ6 --si SIZ6 --seconds 120 --out capture.jsonl

Writes one JSON line per RAW callback (updateMktDepth / updateMktDepthL2 / error / contract) with the VPS receive time,
and prints a summary proving - or disproving - each field: bid / ask price and size, position, insert / update /
delete, market-maker tag, smart-depth flag, error codes. It records depth fields only: no account, position, order or
credential data exists in these callbacks and none is requested. It never places, modifies or cancels orders.
"""
from __future__ import annotations

import argparse
import json
import threading
import time
from collections import Counter

from .contracts import CURRENCY, EXCHANGE, Unresolved, select_contract


def main() -> int:
    from ibapi.client import EClient
    from ibapi.contract import Contract
    from ibapi.wrapper import EWrapper

    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=4001)
    ap.add_argument("--client-id", type=int, default=72)
    ap.add_argument("--gc", required=True, help="GC local symbol to capture (the Databento active contract, e.g. GCZ6)")
    ap.add_argument("--si", required=True, help="SI local symbol (e.g. SIZ6)")
    ap.add_argument("--rows", type=int, default=10)
    ap.add_argument("--seconds", type=int, default=120)
    ap.add_argument("--out", default="ibkr-depth-capture.jsonl")
    a = ap.parse_args()
    out = open(a.out, "w", encoding="utf-8")
    stats: dict[str, Counter] = {"GC": Counter(), "SI": Counter()}
    details: dict[int, list] = {1: [], 2: []}
    roots = {1: ("GC", a.gc), 2: ("SI", a.si)}
    done = threading.Event()
    lock = threading.Lock()

    def rec(kind: str, **kw) -> None:
        with lock:
            out.write(json.dumps({"kind": kind, "recvMs": int(time.time() * 1000), **kw}) + "\n")

    class App(EWrapper, EClient):
        def __init__(self) -> None:
            EWrapper.__init__(self)
            EClient.__init__(self, wrapper=self)

        def nextValidId(self, orderId):  # noqa: N802
            for rid, (root, local) in roots.items():
                c = Contract()
                c.secType, c.symbol, c.localSymbol, c.exchange, c.currency = "FUT", root, local, EXCHANGE, CURRENCY
                self.reqContractDetails(rid, c)

        def contractDetails(self, reqId, cd):  # noqa: N802
            c = cd.contract
            details[reqId].append({"conId": c.conId, "symbol": c.symbol, "localSymbol": c.localSymbol, "secType": c.secType, "exchange": c.exchange,
                                   "currency": c.currency, "tradingClass": c.tradingClass, "multiplier": c.multiplier,
                                   "lastTradeDateOrContractMonth": c.lastTradeDateOrContractMonth, "minTick": cd.minTick})

        def contractDetailsEnd(self, reqId):  # noqa: N802
            root, local = roots[reqId]
            try:
                r = select_contract(root, local, details[reqId])
            except Unresolved as e:
                rec("unresolved", root=root, detail=str(e))
                print(f"{root}: UNRESOLVED - {e}")
                return
            rec("contract", root=root, contract=r.public())
            print(f"{root}: resolved {r.public()}")
            c = Contract()
            c.conId, c.exchange = r.con_id, EXCHANGE
            self.reqMktDepth(10 + reqId, c, a.rows, False, [])

        def error(self, *args):
            rec("error", args=[x if isinstance(x, (int, str)) else str(x) for x in args])

        def updateMktDepth(self, reqId, position, operation, side, price, size):  # noqa: N802
            root = roots[reqId - 10][0]
            stats[root][f"op{operation}"] += 1
            stats[root][f"side{side}"] += 1
            stats[root]["maxPos"] = max(stats[root]["maxPos"], position)
            rec("updateMktDepth", root=root, position=position, operation=operation, side=side, price=price, size=float(size))

        def updateMktDepthL2(self, reqId, position, marketMaker, operation, side, price, size, isSmartDepth=False):  # noqa: N802
            root = roots[reqId - 10][0]
            stats[root][f"op{operation}"] += 1
            stats[root][f"side{side}"] += 1
            stats[root]["L2"] += 1
            stats[root]["mm"] += 1 if marketMaker else 0
            stats[root]["smart"] += 1 if isSmartDepth else 0
            stats[root]["maxPos"] = max(stats[root]["maxPos"], position)
            rec("updateMktDepthL2", root=root, position=position, marketMaker=marketMaker, operation=operation, side=side, price=price,
                size=float(size), isSmartDepth=bool(isSmartDepth))

    app = App()
    app.connect(a.host, a.port, a.client_id)
    t = threading.Thread(target=app.run, daemon=True)
    t.start()
    done.wait(a.seconds)
    for rid in roots:
        app.cancelMktDepth(10 + rid, False)
    app.disconnect()
    out.close()
    print("\nSUMMARY (op0=insert op1=update op2=delete, side0=ask side1=bid)")
    for root, s in stats.items():
        print(f"  {root}: {dict(s)}")
        print(f"    bid+ask rows: {'PROVEN' if s['side0'] and s['side1'] else 'NOT OBSERVED'} | insert/update/delete: "
              f"{'/'.join('yes' if s[f'op{i}'] else 'no' for i in range(3))} | market-maker tag: {'present' if s['mm'] else 'absent'} | "
              f"order ids: NOT PROVIDED by reqMktDepth (aggregated levels - MBO NOT PROVEN)")
    print(f"raw callbacks: {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
