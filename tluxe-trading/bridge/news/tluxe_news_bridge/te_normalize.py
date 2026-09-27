"""Trading Economics payload -> TLUXE normalized records (vendor fields preserved, nothing invented).

Calendar (REST /calendar..., /calendar/updates and the streaming "calendar" topic) - documented fields:
  CalendarId, Date, Country, Category, Event, Reference, ReferenceDate, Source, SourceURL, Actual, Previous,
  Forecast, TEForecast, URL, DateSpan, Importance, LastUpdate, Revised, Currency, Unit, Ticker, Symbol
News (REST /news, streaming "news") - documented fields: id, title, date, description, country, category, symbol, url,
  importance.

Rules:
  * Trading Economics times are UTC; a timestamp without an offset is read as UTC (never as local time).
  * Importance 1 / 2 / 3 -> LOW / MEDIUM / HIGH; the raw value is kept. Anything else -> null (not guessed).
  * Actual / Forecast / Previous / Revised / TEForecast are kept exactly as supplied (text); an absent or empty
    value is null - never 0, never copied from another field. A release is RELEASED only when Actual is present.
  * The raw provider record is kept (`raw`) for audit.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

PROVIDER = "tradingeconomics"
PROVIDER_NAME = "Trading Economics"
IMPORTANCE = {1: "LOW", 2: "MEDIUM", 3: "HIGH"}
TE_SITE = "https://tradingeconomics.com"
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$", re.I)
CALENDAR_FIELDS = ("CalendarId", "Date", "Country", "Category", "Event", "Reference", "ReferenceDate", "Source", "SourceURL", "Actual",
                   "Previous", "Forecast", "TEForecast", "URL", "DateSpan", "Importance", "LastUpdate", "Revised", "Currency", "Unit",
                   "Ticker", "Symbol")


def _get(rec: dict, name: str):
    """Case-insensitive field access (REST uses PascalCase; streaming messages may differ in case)."""
    if name in rec:
        return rec[name]
    low = name.lower()
    for k, v in rec.items():
        if isinstance(k, str) and k.lower() == low:
            return v
    return None


def text(v) -> str | None:
    """Provider value as text; absent / empty / whitespace -> None (never 0)."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        if v != v:  # NaN
            return None
        return str(int(v)) if isinstance(v, float) and v.is_integer() and abs(v) < 1e15 else str(v)
    s = str(v).strip()
    return s or None


def te_time_ms(v) -> int | None:
    """Trading Economics timestamp -> epoch ms (UTC). Naive timestamps are UTC by the provider's contract."""
    s = text(v)
    if s is None or not _ISO.match(s) or s.startswith("0001-"):
        return None
    s = s.replace(" ", "T")
    if s[-1:] in ("Z", "z"):
        s = s[:-1] + "+00:00"
    frac = re.search(r"\.(\d+)", s)
    micro = int((frac.group(1) + "000000")[:6]) if frac else 0
    if frac:
        s = s.replace(frac.group(0), "")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp()) * 1000 + micro // 1000


def importance_of(v) -> tuple[str | None, int | None]:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None, None
    return IMPORTANCE.get(n), n


def _site_url(v) -> str | None:
    s = text(v)
    if not s:
        return None
    if s.startswith("http://") or s.startswith("https://"):
        return s
    return TE_SITE + (s if s.startswith("/") else "/" + s)


def _http_url(v) -> str | None:
    s = text(v)
    return s if s and (s.startswith("https://") or s.startswith("http://")) else None


def normalize_calendar(rec: object, received_ms: int) -> dict | None:
    """One Trading Economics calendar record -> normalized event, or None when unusable (never repaired)."""
    if not isinstance(rec, dict):
        return None
    cid = text(_get(rec, "CalendarId"))
    title = text(_get(rec, "Event"))
    when = te_time_ms(_get(rec, "Date"))
    if not cid or not title or when is None:
        return None
    label, raw_importance = importance_of(_get(rec, "Importance"))
    actual = text(_get(rec, "Actual"))
    return {
        "id": f"{PROVIDER}:{cid}",
        "dedupKey": f"{PROVIDER}:{cid}",
        "provider": PROVIDER,
        "providerName": PROVIDER_NAME,
        "providerEventId": cid,
        "event": title,
        "category": text(_get(rec, "Category")),
        "country": text(_get(rec, "Country")),
        "currency": text(_get(rec, "Currency")),
        "reference": text(_get(rec, "Reference")),
        "referenceDate": te_time_ms(_get(rec, "ReferenceDate")),
        "scheduledAt": when,
        "dateSpan": text(_get(rec, "DateSpan")),
        "importance": label,
        "importanceRaw": raw_importance,
        "actual": actual,
        "forecast": text(_get(rec, "Forecast")),
        "previous": text(_get(rec, "Previous")),
        "revised": text(_get(rec, "Revised")),
        "teForecast": text(_get(rec, "TEForecast")),
        "unit": text(_get(rec, "Unit")),
        "ticker": text(_get(rec, "Ticker")),
        "symbol": text(_get(rec, "Symbol")),
        "source": text(_get(rec, "Source")),
        "sourceUrl": _http_url(_get(rec, "SourceURL")),
        "url": _site_url(_get(rec, "URL")),
        "providerUpdatedAt": te_time_ms(_get(rec, "LastUpdate")),
        "releaseStatus": "RELEASED" if actual is not None else "SCHEDULED",
        "receivedAt": received_ms,
        "raw": {k: rec[k] for k in rec if isinstance(k, str) and k.lower() in {f.lower() for f in CALENDAR_FIELDS}},
    }


def normalize_news(rec: object, received_ms: int, feed: str = "macro") -> dict | None:
    """One Trading Economics news item -> normalized headline, or None when unusable."""
    if not isinstance(rec, dict):
        return None
    nid = text(_get(rec, "id"))
    title = text(_get(rec, "title"))
    published = te_time_ms(_get(rec, "date"))
    if not nid or not title or published is None:
        return None
    label, raw_importance = importance_of(_get(rec, "importance"))
    return {
        "id": f"{PROVIDER}-news:{nid}",
        "dedupKey": f"{PROVIDER}-news:{nid}",
        "provider": PROVIDER,
        "providerName": PROVIDER_NAME,
        "providerItemId": nid,
        "feed": feed,
        "headline": title,
        "description": (text(_get(rec, "description")) or "")[:1000] or None,
        "source": PROVIDER_NAME,
        "sourceUrl": _site_url(_get(rec, "url")),
        "publishedAt": published,
        "receivedAt": received_ms,
        "category": text(_get(rec, "category")),
        "country": text(_get(rec, "country")),
        "symbol": text(_get(rec, "symbol")),
        "importance": label,
        "importanceRaw": raw_importance,
        # Trading Economics does not supply sentiment for news: never filled in by TLUXE.
        "providerSentiment": None,
    }
