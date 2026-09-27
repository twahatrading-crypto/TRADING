"""Instrument-ID <-> actual contract mapping from Databento SymbolMappingMsg records.

Every subscribed symbol (continuous `GC.v.0` or a manual raw contract) is resolved by Databento to an actual
instrument ID and raw contract (e.g. GCZ6). Records are routed by instrument ID ONLY through this map; records
for an instrument that is not the current contract of a root are never applied to that root.
A mapping change for a root = a ROLL: recorded (auditable, bounded history) and reported to the caller so
contract-specific state is reinitialised (never two contracts in one book / footprint / profile).
"""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field


@dataclass
class Resolution:
    root: str
    subscribed: str
    instrument_id: int
    contract: str
    since_ns: int
    received_ms: int


@dataclass
class SymbolMap:
    symbols: dict  # subscribed symbol -> root, e.g. {"GC.v.0": "GC"}
    current: dict = field(default_factory=dict)  # root -> Resolution
    by_id: dict = field(default_factory=dict)  # instrument_id -> contract (all seen, bounded)
    rolls: deque = field(default_factory=lambda: deque(maxlen=50))
    mappings: int = 0

    def on_mapping(self, r, now_ms: int | None = None) -> tuple[str, Resolution | None, Resolution] | None:
        """Process a SymbolMappingMsg. Returns (root, previous, new) when the root's contract CHANGED."""
        self.mappings += 1
        stype_in_symbol = str(r.stype_in_symbol)
        contract = str(r.stype_out_symbol)
        iid = int(r.instrument_id)
        root = self.symbols.get(stype_in_symbol)
        if len(self.by_id) > 500:
            self.by_id.pop(next(iter(self.by_id)))
        self.by_id[iid] = contract
        if root is None:
            return None
        prev = self.current.get(root)
        new = Resolution(root, stype_in_symbol, iid, contract, int(getattr(r, "ts_event", 0) or 0), now_ms if now_ms is not None else int(time.time() * 1000))
        if prev is not None and prev.instrument_id == iid:
            return None
        self.current[root] = new
        if prev is not None:
            self.rolls.append({"root": root, "from": prev.contract, "fromId": prev.instrument_id, "to": contract, "toId": iid, "tsEventNs": new.since_ns, "atMs": new.received_ms})
        return root, prev, new

    def root_of(self, instrument_id: int) -> str | None:
        for root, res in self.current.items():
            if res.instrument_id == instrument_id:
                return root
        return None
