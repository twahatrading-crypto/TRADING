"""Durable storage behind one interface.

  PgStore     - PostgreSQL (production; DATABASE_URL). Versioned migrations (migrations/NNNN_*.sql) applied in order
                inside a transaction, serialized by an advisory lock, recorded with a checksum (an edited applied
                migration is refused). Retention (migrations/retention.sql) runs daily.
  MemoryStore - development without a database only (nothing survives a restart; production refuses it).
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("tluxe.gateway.store")
MIGRATIONS = Path(__file__).parent / "migrations"
_MIG_RE = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")
ADVISORY_KEY = 0x71_75_78_65  # "tluxe"


def _ts(ms: int | None):
    return None if ms is None else datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def migration_files() -> list[tuple[int, str, str, str]]:
    out = []
    for p in sorted(MIGRATIONS.glob("*.sql")):
        m = _MIG_RE.match(p.name)
        if m:
            sql = p.read_text(encoding="utf-8")
            out.append((int(m.group(1)), p.name, sql, hashlib.sha256(sql.encode()).hexdigest()))
    return out


class MemoryStore:
    kind = "memory"

    def __init__(self) -> None:
        self.status: dict[str, dict] = {}
        self.sessions: dict[str, dict] = {}
        self.calendar: dict[str, dict] = {}
        self.headlines: dict[str, dict] = {}
        self.alerts: dict[str, dict] = {}
        self.snapshots: list[dict] = []
        self.integrity: list[dict] = []
        self.auth: list[dict] = []

    async def open(self) -> None:
        pass

    async def close(self) -> None:
        pass

    async def migrate(self) -> list[str]:
        return []

    async def ping(self) -> dict:
        return {"ok": True, "kind": self.kind, "schemaVersion": None}

    async def record_status(self, kind: str, component: str, state: str, detail: str | None, market_open: bool | None) -> None:
        self.status[component] = {"kind": kind, "component": component, "state": state, "detail": detail, "marketOpen": market_open, "observedAt": int(time.time() * 1000)}

    async def last_statuses(self) -> dict[str, dict]:
        return dict(self.status)

    async def session_create(self, sid_hash: str, ttl_s: int) -> None:
        self.sessions[sid_hash] = {"expires": time.time() + ttl_s, "revoked": False}

    async def session_valid(self, sid_hash: str) -> bool:
        s = self.sessions.get(sid_hash)
        return bool(s) and not s["revoked"] and s["expires"] > time.time()

    async def session_revoke(self, sid_hash: str) -> None:
        if sid_hash in self.sessions:
            self.sessions[sid_hash]["revoked"] = True

    async def auth_event(self, kind: str, detail: str | None = None) -> None:
        self.auth.append({"kind": kind, "detail": detail})

    async def upsert_calendar(self, e: dict) -> str:
        old = self.calendar.get(e["dedupKey"])
        self.calendar[e["dedupKey"]] = e
        return "new" if old is None else ("revised" if old.get("revision") != e.get("revision") else "duplicate")

    async def upsert_headline(self, h: dict) -> None:
        self.headlines[h["dedupKey"]] = h

    async def add_alert(self, a: dict) -> bool:
        if a["alertKey"] in self.alerts:
            return False
        self.alerts[a["alertKey"]] = a
        return True

    async def add_snapshot(self, s: dict) -> None:
        self.snapshots.append(s)
        self.snapshots = self.snapshots[-1000:]

    async def add_integrity(self, source: str, instrument: str | None, kind: str, detail: dict) -> None:
        self.integrity.append({"source": source, "instrument": instrument, "kind": kind, "detail": detail})
        self.integrity = self.integrity[-1000:]

    async def retention(self) -> None:
        pass


class PgStore:
    kind = "postgresql"

    def __init__(self, dsn: str) -> None:
        self.dsn = dsn
        self.pool = None

    async def open(self) -> None:
        from psycopg_pool import AsyncConnectionPool

        self.pool = AsyncConnectionPool(self.dsn, min_size=1, max_size=5, open=False, kwargs={"autocommit": True, "application_name": "tluxe-gateway"})
        await self.pool.open(wait=True, timeout=30)

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()

    async def migrate(self) -> list[str]:
        """Apply pending migrations; returns the names applied. Safe to run concurrently (advisory lock)."""
        applied: list[str] = []
        async with self.pool.connection() as conn:
            await conn.execute("SELECT pg_advisory_lock(%s)", (ADVISORY_KEY,))
            try:
                await conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())")
                cur = await conn.execute("SELECT version, checksum FROM schema_migrations")
                done = {v: c for v, c in await cur.fetchall()}
                for version, name, sql, checksum in migration_files():
                    if version in done:
                        if done[version] != checksum:
                            raise RuntimeError(f"Applied migration {name} was modified - create a new migration instead")
                        continue
                    async with conn.transaction():
                        await conn.execute(sql)
                        await conn.execute("INSERT INTO schema_migrations (version, name, checksum) VALUES (%s, %s, %s)", (version, name, checksum))
                    applied.append(name)
                    log.info("database migration applied: %s", name)
            finally:
                await conn.execute("SELECT pg_advisory_unlock(%s)", (ADVISORY_KEY,))
        return applied

    async def _one(self, sql: str, args: tuple = ()):
        async with self.pool.connection() as conn:
            cur = await conn.execute(sql, args)
            return await cur.fetchone() if cur.description else None

    async def _exec(self, sql: str, args: tuple = ()) -> int:
        async with self.pool.connection() as conn:
            cur = await conn.execute(sql, args)
            return cur.rowcount

    async def ping(self) -> dict:
        row = await self._one("SELECT coalesce(max(version), 0) FROM schema_migrations")
        return {"ok": True, "kind": self.kind, "schemaVersion": row[0] if row else None}

    async def record_status(self, kind: str, component: str, state: str, detail: str | None, market_open: bool | None) -> None:
        await self._exec("INSERT INTO status_events (kind, component, state, detail, market_open) VALUES (%s, %s, %s, %s, %s)", (kind, component, state, (detail or "")[:500] or None, market_open))

    async def last_statuses(self) -> dict[str, dict]:
        async with self.pool.connection() as conn:
            cur = await conn.execute("SELECT DISTINCT ON (component) kind, component, state, detail, market_open, observed_at FROM status_events ORDER BY component, observed_at DESC")
            rows = await cur.fetchall()
        return {r[1]: {"kind": r[0], "component": r[1], "state": r[2], "detail": r[3], "marketOpen": r[4], "observedAt": int(r[5].timestamp() * 1000)} for r in rows}

    async def session_create(self, sid_hash: str, ttl_s: int) -> None:
        await self._exec("INSERT INTO sessions (id_sha256, expires_at) VALUES (%s, now() + make_interval(secs => %s))", (sid_hash, ttl_s))

    async def session_valid(self, sid_hash: str) -> bool:
        row = await self._one("UPDATE sessions SET last_seen_at = now() WHERE id_sha256 = %s AND revoked_at IS NULL AND expires_at > now() RETURNING 1", (sid_hash,))
        return row is not None

    async def session_revoke(self, sid_hash: str) -> None:
        await self._exec("UPDATE sessions SET revoked_at = now() WHERE id_sha256 = %s AND revoked_at IS NULL", (sid_hash,))

    async def auth_event(self, kind: str, detail: str | None = None) -> None:
        await self._exec("INSERT INTO auth_events (kind, detail) VALUES (%s, %s)", (kind, (detail or "")[:300] or None))

    async def upsert_calendar(self, e: dict) -> str:
        """Insert or revise ONE row per provider event; revision history kept in news_event_revisions."""
        async with self.pool.connection() as conn, conn.transaction():
            cur = await conn.execute("SELECT revision FROM news_calendar_events WHERE dedup_key = %s FOR UPDATE", (e["dedupKey"],))
            row = await cur.fetchone()
            vals = (e["provider"], e["providerEventId"], e["event"], e.get("category"), e.get("country"), e.get("currency"), e.get("importance"), e.get("importanceRaw"),
                    _ts(e["scheduledAt"]), e.get("actual"), e.get("forecast"), e.get("previous"), e.get("revised"), e.get("unit"), e.get("source"),
                    e.get("sourceUrl"), _ts(e.get("providerUpdatedAt")), e.get("releaseStatus", "SCHEDULED"), _ts(e.get("firstReceivedAt") or e.get("receivedAt")),
                    _ts(e.get("lastChangedAt") or e.get("receivedAt")), e.get("revision", 0), json.dumps(e.get("raw") or {}))
            if row is None:
                await conn.execute("""INSERT INTO news_calendar_events (provider, provider_event_id, event, category, country, currency, importance, importance_raw,
                    scheduled_at, actual, forecast, previous, revised, unit, source, source_url, provider_updated_at, release_status, first_received_at,
                    last_changed_at, revision, raw, dedup_key) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", (*vals, e["dedupKey"]))
                return "new"
            if row[0] == e.get("revision", 0):
                return "duplicate"
            await conn.execute("""UPDATE news_calendar_events SET provider=%s, provider_event_id=%s, event=%s, category=%s, country=%s, currency=%s, importance=%s,
                importance_raw=%s, scheduled_at=%s, actual=%s, forecast=%s, previous=%s, revised=%s, unit=%s, source=%s, source_url=%s, provider_updated_at=%s,
                release_status=%s, first_received_at=%s, last_changed_at=%s, revision=%s, raw=%s WHERE dedup_key=%s""", (*vals, e["dedupKey"]))
            revs = e.get("revisions") or []  # the backend keeps the most recent ones: number them from the current revision
            first = e.get("revision", 0) - len(revs) + 1
            for i, rev in enumerate(revs):
                await conn.execute("INSERT INTO news_event_revisions (dedup_key, revision, changes, observed_at) VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING",
                                   (e["dedupKey"], first + i, json.dumps(rev.get("changes") or {}), _ts(rev.get("at"))))
            return "revised"

    async def upsert_headline(self, h: dict) -> None:
        await self._exec("""INSERT INTO news_headlines (dedup_key, provider, feed, headline, source, source_url, category, country, importance, provider_sentiment,
            published_at, received_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (dedup_key) DO UPDATE SET headline = EXCLUDED.headline,
            source_url = EXCLUDED.source_url, importance = EXCLUDED.importance""",
                         (h["dedupKey"], h["provider"], h["feed"], h["headline"][:500], h.get("source"), h.get("sourceUrl"), h.get("category"), h.get("country"),
                          h.get("importance"), h.get("providerSentiment"), _ts(h["publishedAt"]), _ts(h["receivedAt"])))

    async def add_alert(self, a: dict) -> bool:
        n = await self._exec("""INSERT INTO alerts (alert_key, source, type, title, message, event_key, instrument_id, occurred_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (alert_key) DO NOTHING""",
                             (a["alertKey"], a["source"], a["type"], a["title"][:300], (a.get("message") or "")[:1000] or None, a.get("eventKey"), a.get("instrumentId"), _ts(a["occurredAt"])))
        return n == 1

    async def add_snapshot(self, s: dict) -> None:
        await self._exec("""INSERT INTO engine_snapshots (engine, instrument_id, timeframe, knowledge_time, computed_at, payload) VALUES (%s,%s,%s,%s,%s,%s)
            ON CONFLICT DO NOTHING""", (s["engine"], s["instrumentId"], s.get("timeframe") or "", _ts(s.get("knowledgeTime")), _ts(s["computedAt"]), json.dumps(s["payload"])))

    async def add_integrity(self, source: str, instrument: str | None, kind: str, detail: dict) -> None:
        await self._exec("INSERT INTO data_integrity_events (source, instrument_id, kind, detail) VALUES (%s,%s,%s,%s)", (source, instrument, kind, json.dumps(detail)))

    async def retention(self) -> None:
        async with self.pool.connection() as conn:
            await conn.execute((MIGRATIONS / "retention.sql").read_text(encoding="utf-8"))
