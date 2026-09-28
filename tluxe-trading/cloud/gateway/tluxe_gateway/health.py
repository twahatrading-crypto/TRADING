"""Unified production health. Each component is judged on OBSERVED evidence, never on "the process is running".

States: LIVE · DELAYED · STALE · NOT CONNECTED · UNAVAILABLE · ERROR.
Market data is LIVE only with fresh observed data while its market is expected to be open. During a legitimate
closure (weekend / daily maintenance break) the last data is STALE with `expected: true` and `marketOpen: false`
- never shown as LIVE, never flagged as a failure. Exchange holidays are not modelled (documented limitation).
"""
from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
STATES = ("LIVE", "DELAYED", "STALE", "NOT CONNECTED", "UNAVAILABLE", "ERROR")
FRESH_MS = 60_000


def globex_open(now_ms: int) -> bool:
    """CME Globex metals (GC / SI) and spot FX / metals CFDs (XAUUSD): Sunday 18:00 ET -> Friday 17:00 ET,
    daily break 17:00-18:00 ET (Mon-Thu)."""
    t = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).astimezone(ET)
    wd, hm = t.weekday(), t.hour * 60 + t.minute  # Mon=0 .. Sun=6
    if wd == 5:
        return False
    if wd == 6:
        return hm >= 18 * 60
    if wd == 4:
        return hm < 17 * 60
    return not (17 * 60 <= hm < 18 * 60)


def comp(state: str, detail: str | None = None, **extra) -> dict:
    assert state in STATES, state
    return {"state": state, "detail": detail, **extra}


def market_state(connected: bool, last_event_ms: int | None, now_ms: int, market_open: bool, what: str) -> dict:
    """LIVE / STALE / NOT CONNECTED for a market-data feed, market-hours aware."""
    if not connected:
        return comp("NOT CONNECTED", f"{what} not connected.", marketOpen=market_open)
    if last_event_ms is None:
        return comp("STALE", f"No {what} data observed yet.", marketOpen=market_open, expected=not market_open, lastEventMs=None)
    age = now_ms - last_event_ms
    if market_open and age <= FRESH_MS:
        return comp("LIVE", f"Last {what} data {round(age / 1000)} s ago.", marketOpen=True, expected=False, lastEventMs=last_event_ms)
    if not market_open:
        return comp("STALE", f"Market closed - last {what} data {round(age / 60000)} min ago (expected).", marketOpen=False, expected=True, lastEventMs=last_event_ms)
    return comp("STALE", f"No {what} data for {round(age / 1000)} s while the market is open.", marketOpen=True, expected=False, lastEventMs=last_event_ms)


def ai_states(h: dict | None, configured: bool, err: str | None) -> tuple[dict, dict]:
    """(TLUXE AI service, OpenAI provider)."""
    if not configured:
        return comp("NOT CONNECTED", "TLUXE_AI_URL / TLUXE_AI_TOKEN not configured."), comp("NOT CONNECTED", "TLUXE AI service not configured.")
    if h is None:
        return comp("UNAVAILABLE", err or "TLUXE AI service not reachable."), comp("UNAVAILABLE", "TLUXE AI service not reachable.")
    status = h.get("status")
    provider = {"CONNECTED": comp("LIVE", f"OpenAI verified model {h.get('model')}."),
                "NOT_CONFIGURED": comp("NOT CONNECTED", "OPENAI_API_KEY not set on the AI service."),
                "AUTH_ERROR": comp("ERROR", h.get("reason") or "OpenAI rejected the API key."),
                "MODEL_UNAVAILABLE": comp("ERROR", h.get("reason") or "Configured model unavailable."),
                "RATE_LIMITED": comp("UNAVAILABLE", h.get("reason") or "OpenAI rate limited."),
                "UNREACHABLE": comp("UNAVAILABLE", h.get("reason") or "OpenAI unreachable.")}.get(status, comp("ERROR", h.get("reason") or f"AI provider status {status}."))
    service = comp("LIVE", "TLUXE AI service responding (read-only).", readOnly=bool((h.get("permissions") or {}).get("readOnly")))
    return service, provider


def databento_state(h: dict | None, configured: bool, err: str | None, now_ms: int) -> dict:
    if not configured:
        return comp("NOT CONNECTED", "TLUXE_DATABENTO_URL / TLUXE_DB_BRIDGE_TOKEN not configured.")
    if h is None:
        return comp("UNAVAILABLE", err or "Databento service not reachable.")
    inst = h.get("instruments") or {}
    open_ = globex_open(now_ms)
    statuses = [i.get("status") for i in inst.values()]
    if "AUTH_ERROR" in statuses:
        return comp("ERROR", "Databento rejected the API key (AUTH_ERROR).", marketOpen=open_)
    if statuses and all(s == "UNAVAILABLE" for s in statuses):
        return comp("UNAVAILABLE", "Databento data unavailable (entitlement / not configured).", marketOpen=open_)
    tape = (h.get("sessions") or {}).get("tape") or {}
    connected = tape.get("state") == "CONNECTED"
    last = max((i.get("lastEventNs") or 0) for i in inst.values()) // 1_000_000 if inst else 0
    s = market_state(connected, last or None, now_ms, open_, "Databento trade / OHLCV")
    s["plan"] = h.get("plan")
    s["depth"] = "UNSUPPORTED" if h.get("plan") == "standard" else None
    return s


def news_state(h: dict | None, configured: bool, err: str | None) -> dict:
    if not configured:
        return comp("NOT CONNECTED", "TLUXE_NEWS_URL / TLUXE_NEWS_TOKEN not configured.")
    if h is None:
        return comp("UNAVAILABLE", err or "News service not reachable.")
    cal = (h.get("feeds") or {}).get("calendar") or {}
    st = cal.get("status")
    m = {"LIVE": "LIVE", "DELAYED": "DELAYED", "STALE": "STALE", "NOT_CONFIGURED": "NOT CONNECTED", "DISABLED": "NOT CONNECTED", "ERROR": "ERROR", "CONNECTING": "UNAVAILABLE"}
    return comp(m.get(st, "UNAVAILABLE"), cal.get("detail"), feeds={k: (v or {}).get("status") for k, v in (h.get("feeds") or {}).items()})


def mt5_states(link: dict, terminal: dict | None, now_ms: int) -> tuple[dict, dict]:
    """(MT5 bridge link, MT5 terminal / feed)."""
    if not link.get("connected"):
        return comp("NOT CONNECTED", link.get("detail") or "No MT5 bridge link from the Windows VPS."), comp("NOT CONNECTED", "MT5 bridge link not connected.")
    if link.get("stale"):
        return comp("STALE", "MT5 bridge link heartbeat overdue."), comp("STALE", "MT5 bridge link stale.")
    bridge = comp("LIVE", f"MT5 bridge link {link.get('bridgeId')} connected (read-only).")
    if terminal is None:
        return bridge, comp("UNAVAILABLE", "MT5 terminal status not yet received.")
    t = (terminal.get("terminal") or {})
    if t.get("state") != "CONNECTED":
        return bridge, comp("NOT CONNECTED", f"MT5 terminal {t.get('state') or 'unknown'}.")
    last = terminal.get("lastQuoteMs")
    return bridge, market_state(True, last, now_ms, globex_open(now_ms), "MT5 quote")


def _utc(ms: int | None) -> str | None:
    if not ms:
        return None
    import datetime as _dt
    return _dt.datetime.fromtimestamp(ms / 1000, _dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def databento_summary(h: dict | None, configured: bool, err: str | None, now_ms: int, *, source: str | None,
                      last_trade: dict | None = None, last_bar: dict | None = None, root: str = "GC") -> dict:
    """Safe Databento status for one root (default COMEX GC): connection, dataset, active contract, last event, freshness,
    and the most recent REAL trade / OHLCV bar actually received. Never includes keys, tokens or raw provider errors."""
    state = databento_state(h, configured, err, now_ms)
    inst = ((h or {}).get("instruments") or {}).get(root) or {}
    tape = ((h or {}).get("sessions") or {}).get("tape") or {}
    last_ms = (inst.get("lastEventNs") or 0) // 1_000_000 or None
    counts = (inst.get("tape") or {}).get("counts") or {}
    trades_seen = int((inst.get("counts") or {}).get("trades") or 0)
    bars_seen = int((inst.get("counts") or {}).get("ohlcv") or 0)
    ents = (((h or {}).get("schemas") or {}).get("entitlements") or {})
    trade = None
    if last_trade:
        trade = {"price": last_trade.get("price"), "size": last_trade.get("size"), "side": last_trade.get("side"),
                 "timeUtc": _utc((last_trade.get("tsEventNs") or 0) // 1_000_000)}
    bar = None
    if last_bar:
        bar = {k: last_bar.get(k) for k in ("open", "high", "low", "close", "volume", "isClosed")}
        bar["timeUtc"] = _utc(int(last_bar.get("time") or 0) * 1000)
    return {
        "provider": "Databento",
        "source": source,  # "embedded" (inside the gateway container) | "service" (separate Railway service) | None
        "state": state["state"],
        "detail": state.get("detail"),
        "connection": tape.get("state") if h else ("NOT CONNECTED" if not configured else "UNAVAILABLE"),
        "dataset": (h or {}).get("dataset"),
        "plan": (h or {}).get("plan"),
        "market": "COMEX" if root in ("GC", "SI") else None,
        "root": root,
        "subscribed": inst.get("subscribed"),
        "activeContract": inst.get("contract"),
        "instrumentId": inst.get("instrumentId"),
        "instrumentStatus": inst.get("status"),
        "lastEventUtc": _utc(last_ms),
        "lastEventAgeMs": None if last_ms is None else max(0, now_ms - last_ms),
        "freshness": state["state"] if last_ms else "NO DATA YET",
        "marketOpen": globex_open(now_ms),
        "received": {"trades": trades_seen, "ohlcvBars": bars_seen, "tapeCounts": counts},
        # Real historical OHLCV of the current contract (Databento Historical API) - state, bar counts, estimated cost.
        "history": inst.get("history"),
        "lastTrade": trade,
        "lastBar": bar,
        # Only real records received from Databento make this true - never configuration alone.
        "verifiedByRealData": bool(last_ms and (trades_seen > 0 or bars_seen > 0) and (trade or bar)),
        "schemas": {k: (v or {}).get("state") for k, v in ents.items()},
        "depth": "UNSUPPORTED" if (h or {}).get("plan") == "standard" else None,
        "timeUtc": _utc(now_ms),
    }
