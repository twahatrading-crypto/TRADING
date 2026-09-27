"""Bounded, de-duplicating record stores with revision history.

A repeated provider update with identical content is a DUPLICATE (counted, not re-published). A changed update for
the same provider id is a REVISION of the SAME record (never a second event): the change is recorded in `revisions`
(field, old, new, at) and the record is re-published with a new sequence number so clients pick it up.
"""
from __future__ import annotations

import threading

MAX_REVISIONS = 20
CALENDAR_MATERIAL = ("event", "category", "country", "currency", "scheduledAt", "importance", "importanceRaw", "actual", "forecast",
                     "previous", "revised", "teForecast", "unit", "reference", "source", "sourceUrl", "url", "releaseStatus", "dateSpan")
NEWS_MATERIAL = ("headline", "description", "category", "country", "symbol", "importance", "sourceUrl", "publishedAt")


class RecordStore:
    def __init__(self, material: tuple[str, ...], max_records: int, time_field: str, clock) -> None:
        self.material = material
        self.max_records = max_records
        self.time_field = time_field
        self.now = clock
        self.lock = threading.Lock()
        self.records: dict[str, dict] = {}
        self.seq = 0
        self.counts = {"received": 0, "new": 0, "revised": 0, "duplicates": 0}

    def upsert(self, rec: dict) -> str:
        """Returns 'new' | 'revised' | 'duplicate'."""
        with self.lock:
            self.counts["received"] += 1
            key = rec["dedupKey"]
            old = self.records.get(key)
            if old is None:
                self.seq += 1
                self.records[key] = {**rec, "firstReceivedAt": rec["receivedAt"], "lastChangedAt": rec["receivedAt"], "revision": 0, "revisions": [], "seq": self.seq}
                self.counts["new"] += 1
                self._prune()
                return "new"
            changes = {f: [old.get(f), rec.get(f)] for f in self.material if old.get(f) != rec.get(f)}
            if not changes:
                self.counts["duplicates"] += 1
                old["lastSeenAt"] = rec["receivedAt"]
                return "duplicate"
            self.seq += 1
            revisions = (old["revisions"] + [{"at": rec["receivedAt"], "providerUpdatedAt": rec.get("providerUpdatedAt"), "changes": changes}])[-MAX_REVISIONS:]
            self.records[key] = {**rec, "firstReceivedAt": old["firstReceivedAt"], "lastChangedAt": rec["receivedAt"], "revision": old["revision"] + 1,
                                 "revisions": revisions, "seq": self.seq}
            self.counts["revised"] += 1
            return "revised"

    def _prune(self) -> None:
        if len(self.records) <= self.max_records:
            return
        for key, _ in sorted(self.records.items(), key=lambda kv: kv[1].get(self.time_field) or 0)[: len(self.records) - self.max_records]:
            del self.records[key]

    def since(self, seq: int, limit: int) -> tuple[list[dict], int]:
        with self.lock:
            out = sorted((r for r in self.records.values() if r["seq"] > seq), key=lambda r: r["seq"])[:limit]
            return [dict(r) for r in out], self.seq

    def all(self) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.records.values()]

    def __len__(self) -> int:
        return len(self.records)
