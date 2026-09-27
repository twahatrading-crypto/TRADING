"""Classify Databento gateway / SDK error text: authentication vs entitlement vs other.

A schema the subscription does not include (e.g. "Not authorized for mbo schema" on CME Globex MDP 3.0 Standard) is
an ENTITLEMENT limit of that one schema - never an authentication failure of the whole provider. Entitlement
patterns are therefore checked BEFORE authentication patterns ("authorized" contains "auth").
"""
from __future__ import annotations

import re

AUTH, ENTITLEMENT, OTHER = "AUTH", "ENTITLEMENT", "ERROR"

_ENTITLEMENT = ("not authorized for", "not authorised for", "not entitled", "entitlement", "not licensed", "license", "licence",
                "permission", "not subscribed", "subscription does not", "not included in")
_AUTH = ("authentication failed", "auth failed", "failed to authenticate", "invalid api key", "api key", "authenticat", "cram")
# Longest names first so "mbp-10" never reads as "mbp-1".
_SCHEMA_RE = re.compile(r"(?<![\w-])(mbp-10|mbp-1|mbo|tbbo|cmbp-1|cbbo-1[sm]|bbo-1[sm]|trades|ohlcv-1[smhd]|ohlcv-eod|definition|statistics|status|imbalance)(?![\w-])")


def classify(message: str) -> tuple[str, str | None]:
    """(kind, schema or None). kind: AUTH | ENTITLEMENT | ERROR. The message must already be redacted."""
    low = (message or "").lower()
    m = _SCHEMA_RE.search(low)
    schema = m.group(1) if m else None
    if any(p in low for p in _ENTITLEMENT):
        return ENTITLEMENT, schema
    if any(p in low for p in _AUTH):
        return AUTH, None
    return OTHER, schema
