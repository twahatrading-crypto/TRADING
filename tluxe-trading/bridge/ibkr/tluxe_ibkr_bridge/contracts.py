"""Resolve the genuine IBKR COMEX futures contract for a TLUXE root - never a guessed contract id.

TLUXE canonical roots GC / SI are mapped to the SAME contract Databento is trading (the gateway sends that local
symbol, e.g. GCZ6 / SIZ6), so depth and trades never come from different expiries across a roll. The candidates come
from IBKR's own `reqContractDetails`; exactly one must match root, local symbol, exchange COMEX, currency USD, trading
class (SI, not the micro SIL) and the standard multiplier, or the root stays UNRESOLVED.
"""
from __future__ import annotations

from dataclasses import dataclass

EXCHANGE = "COMEX"
CURRENCY = "USD"
# Standard (not micro / mini) contract sizes - a sanity check against selecting the wrong product, not an identifier.
MULTIPLIER = {"GC": "100", "SI": "5000"}


@dataclass(frozen=True)
class Resolved:
    root: str
    con_id: int
    local_symbol: str
    symbol: str
    exchange: str
    currency: str
    expiry: str
    trading_class: str
    multiplier: str
    min_tick: float

    def public(self) -> dict:
        return {"conId": self.con_id, "localSymbol": self.local_symbol, "symbol": self.symbol, "exchange": self.exchange,
                "currency": self.currency, "expiry": self.expiry, "tradingClass": self.trading_class,
                "multiplier": self.multiplier, "minTick": self.min_tick}


class Unresolved(Exception):
    pass


def select_contract(root: str, target_local_symbol: str | None, details: list[dict]) -> Resolved:
    if root not in MULTIPLIER:
        raise Unresolved(f"{root} is not a supported COMEX root")
    if not target_local_symbol:
        raise Unresolved(f"{root}: no target contract yet (waiting for the active Databento contract)")
    hits = [d for d in details
            if d.get("symbol") == root and d.get("localSymbol") == target_local_symbol and d.get("exchange") == EXCHANGE
            and d.get("currency") == CURRENCY and d.get("tradingClass") == root and str(d.get("multiplier")) == MULTIPLIER[root]
            and d.get("secType", "FUT") == "FUT"]
    if len(hits) != 1:
        seen = ", ".join(sorted({f"{d.get('localSymbol')}/{d.get('tradingClass')}/{d.get('exchange')}" for d in details})) or "none"
        raise Unresolved(f"{root}: expected exactly one COMEX FUT {target_local_symbol} (class {root}, x{MULTIPLIER[root]}); IBKR returned {len(hits)} match(es) among [{seen}]")
    d = hits[0]
    return Resolved(root=root, con_id=int(d["conId"]), local_symbol=d["localSymbol"], symbol=d["symbol"], exchange=d["exchange"],
                    currency=d["currency"], expiry=str(d.get("lastTradeDateOrContractMonth") or ""), trading_class=d["tradingClass"],
                    multiplier=str(d["multiplier"]), min_tick=float(d.get("minTick") or 0))
