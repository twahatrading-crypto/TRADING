"""Classify Databento gateway / SDK error text: authentication vs entitlement vs other.

A schema the subscription does not include (e.g. "Not authorized for mbo schema" on CME Globex MDP 3.0 Standard) is
an ENTITLEMENT limit of that one schema - never an authentication failure of the whole provider. Entitlement
patterns are therefore checked BEFORE authentication patterns ("authorized" contains "auth").
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

AUTH, ENTITLEMENT, START, OTHER = "AUTH", "ENTITLEMENT", "START", "ERROR"

_ENTITLEMENT = ("not authorized for", "not authorised for", "not entitled", "entitlement", "not licensed", "license", "licence",
                "permission", "not subscribed", "subscription does not", "not included in")
_AUTH = ("authentication failed", "auth failed", "failed to authenticate", "invalid api key", "api key", "authenticat", "cram")
# Longest names first so "mbp-10" never reads as "mbp-1".
_SCHEMA_RE = re.compile(r"(?<![\w-])(mbp-10|mbp-1|mbo|tbbo|cmbp-1|cbbo-1[sm]|bbo-1[sm]|trades|ohlcv-1[smhd]|ohlcv-eod|definition|statistics|status|imbalance)(?![\w-])")


# Databento live gateway: "Invalid start time. Must be 2026-09-26T12:40:00Z or later." (intraday replay window).
_START_RE = re.compile(r"invalid start time", re.I)
_BOUNDARY_RE = re.compile(r"must be\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?\s*(?:Z|[+-]\d{2}:?\d{2})?)\s+or later", re.I)


def parse_start_boundary_ns(message: str) -> int | None:
    """Earliest allowed replay start (UTC ns) from an "Invalid start time. Must be <ISO> or later" error, else None.
    Only a well-formed timestamp is accepted; anything else returns None (the caller then falls back safely)."""
    m = _BOUNDARY_RE.search(message or "")
    if not m:
        return None
    raw = m.group(1).strip().replace(" ", "T")
    if raw.endswith(("Z", "z")):
        raw = raw[:-1] + "+00:00"
    frac = re.search(r"\.(\d+)", raw)
    ns_frac = int((frac.group(1) + "000000000")[:9]) if frac else 0
    if frac:
        raw = raw.replace(frac.group(0), "")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp()) * 1_000_000_000 + ns_frac


def classify(message: str) -> tuple[str, str | None]:
    """(kind, schema or None). kind: AUTH | ENTITLEMENT | START | ERROR. The message must already be redacted."""
    low = (message or "").lower()
    if _START_RE.search(low):
        return START, None  # replay start outside the gateway's window: not auth, not entitlement
    m = _SCHEMA_RE.search(low)
    schema = m.group(1) if m else None
    if any(p in low for p in _ENTITLEMENT):
        return ENTITLEMENT, schema
    if any(p in low for p in _AUTH):
        return AUTH, None
    return OTHER, schema
