"""TLUXE cloud gateway: the ONE public service (web app + API on one HTTPS origin).

Browser --HTTPS/WSS--> gateway --private network--> tluxe-ai · tluxe-databento · tluxe-news   (+ PostgreSQL)
                                      ^-- outbound WSS from the Windows VPS MT5 remote link (/bridge/mt5)

Public, unauthenticated: /healthz (liveness), /readyz (readiness), static web assets, /api/auth/login, /api/config.
Everything else requires the owner session cookie. Internal service tokens / provider credentials live only in the
gateway's environment and are never returned. Read-only market data and analysis only - no trading routes exist.
"""
from __future__ import annotations

import asyncio
import json
import os
import logging
import re
import time
from pathlib import Path
from urllib.parse import urlparse

from aiohttp import ClientSession, ClientTimeout, WSMsgType, web

from . import __version__
from .auth import COOKIE, ROTATE_AFTER_S, GlobalFailLimiter, LoginLimiter, new_session_id, sid_hash, verify_password
from .config import GatewayConfig, Upstream
from .health import ai_states, comp, databento_state, databento_summary, mt5_states, news_state
from .logs import Redactor
from .depth_history import DepthRecorder, build_matrix, normalize_request
from .ibkr_relay import IbkrRelay
from .mt5_relay import HEARTBEAT_S as MT5_HB_S, Mt5Relay, RelayError, token_ok
from .store import MemoryStore, PgStore
from .stream import StreamHub

log = logging.getLogger("tluxe.gateway")
MAX_JSON = 256_000
MAX_SNAPSHOT = 64_000
DATABENTO_PATH = re.compile(r"^v1/(health|feed|book/(GC|SI)|trades/(GC|SI)|candles/(GC|SI))$")
NEWS_PATH = re.compile(r"^v1/(health|calendar|headlines)$")
SAFE_QUERY = re.compile(r"^[A-Za-z0-9_=&.,%-]{0,300}$")

K_CFG = web.AppKey("cfg", GatewayConfig)
K_STORE = web.AppKey("store", object)
K_RELAY = web.AppKey("relay", Mt5Relay)
K_IBKR = web.AppKey("ibkr", IbkrRelay)
K_DEPTH = web.AppKey("depth", DepthRecorder)
K_HUB = web.AppKey("hub", StreamHub)
K_STATE = web.AppKey("state", dict)
K_HTTP = web.AppKey("http", object)


# ------------------------------------------------------------------ helpers
def _json(data, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, dumps=lambda o: json.dumps(o, separators=(",", ":"), ensure_ascii=False))


def _err(status: int, code: str, message: str) -> web.Response:
    return _json({"error": {"code": code, "message": message}}, status)


def _origin_allowed(request: web.Request) -> bool:
    origin = request.headers.get("Origin")
    return origin is None or origin in request.app[K_CFG].allowed_origins


async def _session(request: web.Request) -> str | None:
    sid = request.cookies.get(COOKIE)
    if not sid or len(sid) > 200:
        return None
    return sid if await request.app[K_STORE].session_valid(sid_hash(sid)) else None


def _set_cookie(resp: web.StreamResponse, cfg: GatewayConfig, sid: str) -> None:
    resp.set_cookie(COOKIE, sid, max_age=cfg.session_ttl_s, httponly=True, secure=cfg.cookie_secure, samesite="Strict", path="/")
    resp.set_cookie(f"{COOKIE}_iat", str(int(time.time())), max_age=cfg.session_ttl_s, httponly=True, secure=cfg.cookie_secure, samesite="Strict", path="/")


async def _upstream_get(app: web.Application, up: Upstream, path: str, timeout: float = 8.0):
    """GET an internal service with its server-side token. Returns (status, json | None, error text | None)."""
    if up.problem:
        return None, None, f"{up.name} service misconfigured: {up.problem}"
    if not up.configured:
        return None, None, f"{up.name} service not configured"
    try:
        async with app[K_HTTP].get(f"{up.url}{path}", headers={"Authorization": f"Bearer {up.token.reveal()}"}, timeout=ClientTimeout(total=timeout)) as r:
            try:
                body = await r.json(content_type=None)
            except (ValueError, UnicodeDecodeError):
                body = None
            return r.status, body, None
    except (asyncio.TimeoutError, OSError, Exception) as exc:  # noqa: BLE001 - reported as unreachable
        return None, None, f"{up.name} service not reachable ({type(exc).__name__})"


# ------------------------------------------------------------------ middleware
@web.middleware
async def security(request: web.Request, handler):
    cfg = request.app[K_CFG]
    origin = request.headers.get("Origin")
    is_api = request.path.startswith("/api/") or request.path.startswith("/bridge/")
    unsafe = request.method not in ("GET", "HEAD", "OPTIONS")
    if is_api and origin is not None and origin not in cfg.allowed_origins:
        log.warning("rejected origin %s on %s", origin[:100], request.path)
        resp = _err(403, "ORIGIN_NOT_ALLOWED", "This origin is not allowed.")
    elif cfg.production and unsafe and request.path.startswith("/api/") and origin is None:
        # CSRF: every state-changing API call (login / logout included) must come from the TLUXE web app's own origin.
        resp = _err(403, "ORIGIN_REQUIRED", "State-changing requests must come from the TLUXE web app.")
    elif request.method == "OPTIONS" and is_api:
        resp = web.Response(status=204)
    else:
        try:
            resp = await handler(request)
        except web.HTTPException as e:
            resp = e if e.status < 400 else _err(e.status, "HTTP_" + str(e.status), e.reason or "error")
        except Exception:  # never leak internals
            log.exception("unhandled error on %s", request.path)
            resp = _err(500, "ERROR", "Internal gateway error.")
    if origin is not None and origin in cfg.allowed_origins and is_api and not isinstance(resp, web.WebSocketResponse):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Credentials"] = "true"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Vary"] = "Origin"
    if not isinstance(resp, web.WebSocketResponse):
        h = resp.headers
        h.setdefault("X-Content-Type-Options", "nosniff")
        h.setdefault("Referrer-Policy", "no-referrer")
        h.setdefault("X-Frame-Options", "DENY")
        h.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        h.setdefault("Content-Security-Policy", "default-src 'self'; connect-src 'self'" + (" " + " ".join(o.replace("https://", "wss://").replace("http://", "ws://") for o in cfg.allowed_origins)) + "; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if cfg.production:
            h.setdefault("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
        if is_api:
            h.setdefault("Cache-Control", "no-store")
    return resp


class PublicRateLimiter:
    """Token bucket per client address for UNAUTHENTICATED market-data requests (public market-data mode only)."""

    def __init__(self, rate_per_s: float = 40.0, burst: float = 200.0, clock=time.monotonic) -> None:
        self.rate, self.burst, self.clock = rate_per_s, burst, clock
        self.buckets: dict[str, tuple[float, float]] = {}

    def allow(self, client: str) -> bool:
        now = self.clock()
        tokens, at = self.buckets.get(client, (self.burst, now))
        tokens = min(self.burst, tokens + (now - at) * self.rate)
        if len(self.buckets) > 10_000:  # bounded memory
            self.buckets.clear()
        if tokens < 1:
            self.buckets[client] = (tokens, now)
            return False
        self.buckets[client] = (tokens - 1, now)
        return True


def _client(request: web.Request) -> str:
    # Behind Railway's proxy the last X-Forwarded-For hop is the address the proxy saw.
    xff = request.headers.get("X-Forwarded-For", "")
    return xff.split(",")[-1].strip() if xff else (request.remote or "?")


def market_data_route(fn):
    """Read-only market data (Databento GC / SI, MT5 relay XAUUSD / XAGUSD). Needs a session like everything else -
    EXCEPT while no owner login is configured (cfg.public_market_data), when GET requests are served without one,
    rate-limited per client. Nothing else is ever opened this way."""
    protected = require_session(fn)

    async def wrapped(request: web.Request):
        if request.app[K_CFG].public_market_data and request.method == "GET":
            if not request.app[K_STATE]["publicLimiter"].allow(_client(request)):
                return _err(429, "RATE_LIMITED", "Too many requests - slow down.")
            return await fn(request)
        return await protected(request)

    return wrapped


def require_session(fn):
    async def wrapped(request: web.Request):
        sid = await _session(request)
        if sid is None:
            return _err(401, "UNAUTHORIZED", "Sign in to TLUXE.")
        if request.method != "GET" and request.headers.get("Origin") is None and request.app[K_CFG].production:
            return _err(403, "ORIGIN_REQUIRED", "State-changing requests must come from the TLUXE web app.")
        request["sid"] = sid
        resp = await fn(request)
        # Rotation: after ROTATE_AFTER_S a fresh session id replaces the old one (old revoked).
        iat = request.cookies.get(f"{COOKIE}_iat", "")
        if iat.isdigit() and time.time() - int(iat) > ROTATE_AFTER_S and isinstance(resp, web.Response):
            new = new_session_id()
            store = request.app[K_STORE]
            await store.session_create(sid_hash(new), request.app[K_CFG].session_ttl_s)
            await store.session_revoke(sid_hash(sid))
            await store.auth_event("ROTATE")
            _set_cookie(resp, request.app[K_CFG], new)
        return resp

    return wrapped


# ------------------------------------------------------------------ public
async def healthz(request: web.Request) -> web.Response:
    return _json({"ok": True})


async def readyz(request: web.Request) -> web.Response:
    try:
        await request.app[K_STORE].ping()
        return _json({"ok": True})
    except Exception:
        return _json({"ok": False}, 503)


async def runtime_config(request: web.Request) -> web.Response:
    cfg = request.app[K_CFG]
    return _json({"mode": "cloud", "env": cfg.env, "version": __version__, "authRequired": not cfg.public_market_data,
                  "publicMarketData": cfg.public_market_data, "streamPath": "/api/stream", "readOnly": True,
                  # IBKR COMEX Level-2 depth link configured (the key hash is set) - a flag only, never the key.
                  "ibkrDepth": bool(cfg.ibkr_bridge_keys) or cfg.ibkr_depth.configured})


async def login(request: web.Request) -> web.Response:
    cfg, store = request.app[K_CFG], request.app[K_STORE]
    limiter: LoginLimiter = request.app[K_STATE]["limiter"]
    global_limiter: GlobalFailLimiter = request.app[K_STATE]["globalLimiter"]
    client = _client(request)  # the address Railway's proxy saw (request.remote is the proxy itself)
    wait = max(limiter.locked(client), global_limiter.blocked())
    if wait:
        return _err(429, "LOCKED", f"Too many attempts - try again in {int(wait) + 1} s.")
    if not cfg.owner_password_hash:
        return _err(503, "AUTH_NOT_CONFIGURED", "Owner sign-in is not configured yet.")
    try:
        body = await request.json()
    except (ValueError, UnicodeDecodeError):
        return _err(400, "INVALID_JSON", "Invalid request.")
    pw = body.get("password") if isinstance(body, dict) else None
    if not isinstance(pw, str) or not (1 <= len(pw) <= 256):
        return _err(400, "INVALID_BODY", "Password required.")
    ok = await asyncio.get_running_loop().run_in_executor(None, verify_password, pw, cfg.owner_password_hash.reveal())
    if not ok:
        limiter.fail(client)
        global_limiter.fail()
        await store.auth_event("LOGIN_FAIL", client)
        return _err(401, "INVALID_CREDENTIALS", "Sign-in failed.")
    limiter.ok(client)
    sid = new_session_id()
    await store.session_create(sid_hash(sid), cfg.session_ttl_s)
    await store.auth_event("LOGIN_OK", client)
    resp = _json({"ok": True})
    _set_cookie(resp, cfg, sid)
    return resp


async def logout(request: web.Request) -> web.Response:
    sid = request.cookies.get(COOKIE)
    if sid:
        await request.app[K_STORE].session_revoke(sid_hash(sid))
        await request.app[K_STORE].auth_event("LOGOUT")
    resp = _json({"ok": True})
    resp.del_cookie(COOKIE, path="/")
    resp.del_cookie(f"{COOKIE}_iat", path="/")
    return resp


@require_session
async def me(request: web.Request) -> web.Response:
    return _json({"authenticated": True, "role": "owner", "readOnly": True})


# ------------------------------------------------------------------ proxies
async def _proxy_get(request: web.Request, up: Upstream, path: str) -> web.Response:
    q = request.query_string
    if q and not SAFE_QUERY.match(q):
        return _err(400, "BAD_QUERY", "Invalid query.")
    status, body, err = await _upstream_get(request.app, up, f"/{path}" + (f"?{q}" if q else ""), 15.0)
    if status is None:
        return _err(503 if "not configured" in (err or "") else 502, "UPSTREAM_UNAVAILABLE", err or "unavailable")
    return _json(body if body is not None else {}, status)


@market_data_route
async def databento_status(request: web.Request) -> web.Response:
    """Safe COMEX GC Databento status, proven by the latest REAL trade / OHLCV bar the gateway can read back."""
    app, cfg = request.app, request.app[K_CFG]
    root = (request.query.get("root") or "GC").upper()
    if root not in ("GC", "SI"):
        return _err(400, "BAD_ROOT", "root must be GC or SI.")
    now = int(time.time() * 1000)
    s, h, err = await _upstream_get(app, cfg.databento, "/v1/health", 6)
    trade = bar = None
    if s == 200 and h:
        lt = ((h.get("instruments") or {}).get(root) or {}).get("tape") or {}
        last_index = int(lt.get("lastIndex") or 0)
        if last_index > 0:
            ts, tb, _ = await _upstream_get(app, cfg.databento, f"/v1/trades/{root}?after={max(0, last_index - 1)}&limit=1", 6)
            if ts == 200 and tb and tb.get("trades"):
                trade = tb["trades"][-1]
        cs, cb, _ = await _upstream_get(app, cfg.databento, f"/v1/candles/{root}?timeframe=M1&limit=2", 6)
        if cs == 200 and cb and cb.get("bars"):
            closed = [b for b in cb["bars"] if b.get("isClosed")]
            bar = (closed or cb["bars"])[-1]
    # Set by the container entrypoint when it runs the bridge next to the gateway (the gateway itself starts nothing).
    embedded = os.environ.get("TLUXE_DATABENTO_SOURCE") == "embedded"
    source = ("embedded" if embedded else "service") if cfg.databento.configured else None
    body = databento_summary(h if s == 200 else None, cfg.databento.configured, err or (None if s == 200 else f"HTTP {s}"), now,
                             source=source, last_trade=trade, last_bar=bar, root=root)
    return _json(body)


@market_data_route
async def databento_proxy(request: web.Request) -> web.Response:
    path = request.match_info["path"]
    if not DATABENTO_PATH.match(path):
        return _err(404, "NOT_FOUND", "Unknown endpoint.")
    return await _proxy_get(request, request.app[K_CFG].databento, path)


@require_session
async def news_proxy(request: web.Request) -> web.Response:
    path = request.match_info["path"]
    if not NEWS_PATH.match(path):
        return _err(404, "NOT_FOUND", "Unknown endpoint.")
    return await _proxy_get(request, request.app[K_CFG].news, path)


@require_session
async def ai_health(request: web.Request) -> web.Response:
    return await _proxy_get(request, request.app[K_CFG].ai, "api/ai/health")


@require_session
async def ai_chat(request: web.Request) -> web.Response:
    up = request.app[K_CFG].ai
    if not up.configured:
        return _err(503, "NOT_CONFIGURED", f"TLUXE AI service is misconfigured: {up.problem}" if up.problem else "TLUXE AI service is not configured.")
    if request.content_length is None or request.content_length > MAX_JSON:
        return _err(413, "BODY_TOO_LARGE", "Request too large.")
    raw = await request.read()
    try:
        async with request.app[K_HTTP].post(f"{up.url}/api/ai/chat", data=raw, headers={"Authorization": f"Bearer {up.token.reveal()}", "Content-Type": "application/json"},
                                            timeout=ClientTimeout(total=120)) as r:
            body = await r.json(content_type=None)
            return _json(body if body is not None else {}, r.status)
    except (asyncio.TimeoutError, OSError, ValueError, Exception):  # noqa: BLE001
        return _err(502, "UPSTREAM_UNAVAILABLE", "TLUXE AI service not reachable.")


@market_data_route
async def mt5_proxy(request: web.Request) -> web.Response:
    if request.method != "GET":
        return _err(405, "READ_ONLY", "MT5 access is read-only market data.")
    path = "/" + request.match_info["path"] + (f"?{request.query_string}" if request.query_string else "")
    try:
        status, body = await request.app[K_RELAY].request(path)
    except RelayError as e:
        return _err(e.status, e.code, e.message)
    return _json(body if body is not None else {}, status)


# ------------------------------------------------------------------ persistence API
def _str(v, n: int) -> str | None:
    return v[:n] if isinstance(v, str) and v.strip() else None


@require_session
async def post_alert(request: web.Request) -> web.Response:
    try:
        b = await request.json()
    except (ValueError, UnicodeDecodeError):
        return _err(400, "INVALID_JSON", "Invalid JSON.")
    if not isinstance(b, dict):
        return _err(400, "INVALID_BODY", "Object required.")
    a = {"alertKey": _str(b.get("alertKey"), 200), "source": _str(b.get("source"), 40), "type": _str(b.get("type"), 60), "title": _str(b.get("title"), 300),
         "message": _str(b.get("message"), 1000), "eventKey": _str(b.get("eventKey"), 200), "instrumentId": _str(b.get("instrumentId"), 20), "occurredAt": b.get("occurredAt")}
    if not all([a["alertKey"], a["source"], a["type"], a["title"]]) or not isinstance(a["occurredAt"], int):
        return _err(400, "INVALID_BODY", "alertKey, source, type, title and occurredAt (ms) are required.")
    created = await request.app[K_STORE].add_alert(a)
    return _json({"ok": True, "created": created})


@require_session
async def post_snapshot(request: web.Request) -> web.Response:
    if request.content_length is None or request.content_length > MAX_SNAPSHOT:
        return _err(413, "BODY_TOO_LARGE", f"Snapshot payload limit is {MAX_SNAPSHOT} bytes.")
    try:
        b = await request.json()
    except (ValueError, UnicodeDecodeError):
        return _err(400, "INVALID_JSON", "Invalid JSON.")
    if not isinstance(b, dict) or not _str(b.get("engine"), 40) or not _str(b.get("instrumentId"), 20) or not isinstance(b.get("computedAt"), int) or not isinstance(b.get("payload"), (dict, list)):
        return _err(400, "INVALID_BODY", "engine, instrumentId, computedAt (ms) and payload are required.")
    await request.app[K_STORE].add_snapshot({"engine": b["engine"][:40], "instrumentId": b["instrumentId"][:20], "timeframe": _str(b.get("timeframe"), 8) or "",
                                             "knowledgeTime": b.get("knowledgeTime") if isinstance(b.get("knowledgeTime"), int) else None, "computedAt": b["computedAt"], "payload": b["payload"]})
    return _json({"ok": True})


# ------------------------------------------------------------------ status
async def compute_status(app: web.Application) -> dict:
    cfg, store, relay, hub = app[K_CFG], app[K_STORE], app[K_RELAY], app[K_HUB]
    now = int(time.time() * 1000)
    out: dict[str, dict] = {}
    static = Path(cfg.static_dir) / "index.html" if cfg.static_dir else None
    out["frontend"] = comp("LIVE", "Web app bundle served by the gateway.") if static and static.is_file() else comp("NOT CONNECTED", "No web bundle configured (TLUXE_STATIC_DIR).")
    out["api"] = comp("LIVE", f"Gateway {__version__} serving ({cfg.env}).")
    try:
        p = await store.ping()
        out["postgres"] = comp("LIVE", f"{p['kind']} schema v{p['schemaVersion']}") if p["kind"] == "postgresql" else comp("NOT CONNECTED", "No DATABASE_URL (development in-memory store - nothing persists).")
    except Exception as exc:  # noqa: BLE001
        out["postgres"] = comp("ERROR", f"Database unreachable ({type(exc).__name__}).")
    s, h, err = await _upstream_get(app, cfg.ai, "/api/ai/health", 6)
    out["ai"], out["openai"] = ai_states(h if s == 200 else None, cfg.ai.configured, err or (None if s == 200 else f"HTTP {s}"))
    s, h, err = await _upstream_get(app, cfg.databento, "/v1/health", 6)
    out["databento"] = databento_state(h if s == 200 else None, cfg.databento.configured, err or (None if s == 200 else f"HTTP {s}"), now)
    s, h, err = await _upstream_get(app, cfg.news, "/v1/health", 6)
    out["news"] = news_state(h if s == 200 else None, cfg.news.configured, err or (None if s == 200 else f"HTTP {s}"))
    # A misconfigured upstream is a real ERROR (never "not connected", never LIVE).
    for key, up in (("ai", cfg.ai), ("databento", cfg.databento), ("news", cfg.news)):
        if up.problem:
            out[key] = comp("ERROR", up.problem)
    if cfg.ai.problem:
        out["openai"] = comp("ERROR", "TLUXE AI service misconfigured on the gateway.")
    link = relay.status()
    if not cfg.mt5_bridge_keys:
        link = {**link, "connected": False, "detail": "No MT5 bridge token hash configured (TLUXE_MT5_BRIDGE_TOKEN_SHA256)."}
    out["mt5Bridge"], out["mt5Feed"] = mt5_states(link, relay.terminal(), now)
    # LIVE only when a browser stream is actually connected - an open endpoint alone is not "live".
    n = len(hub.clients)
    out["websocket"] = comp("LIVE", f"{n} browser stream(s) connected.", clients=n) if n else comp("NOT CONNECTED", "No browser stream connected (endpoint ready).", clients=0)
    return {"timeMs": now, "components": out}


@require_session
async def status_route(request: web.Request) -> web.Response:
    st = request.app[K_STATE].get("status") or await compute_status(request.app)
    return _json({**st, "previous": request.app[K_STATE].get("previousStatus")})


# ------------------------------------------------------------------ websockets
async def stream_ws(request: web.Request) -> web.StreamResponse:
    if request.headers.get("Origin") not in request.app[K_CFG].allowed_origins:
        return _err(403, "ORIGIN_NOT_ALLOWED", "This origin is not allowed.")
    if await _session(request) is None:
        return _err(401, "UNAUTHORIZED", "Sign in to TLUXE.")
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=64_000)
    await ws.prepare(request)
    await request.app[K_HUB].serve(ws)
    return ws


async def bridge_ws(request: web.Request) -> web.StreamResponse:
    cfg, relay, store = request.app[K_CFG], request.app[K_RELAY], request.app[K_STORE]
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else ""
    bridge_id = (request.headers.get("X-TLUXE-Bridge-Id") or "mt5-vps")[:64]
    if not token_ok(token, cfg.mt5_bridge_keys):
        relay.counts["authRejected"] += 1
        await store.auth_event("BRIDGE_REJECTED", bridge_id)
        return _err(401, "UNAUTHORIZED", "Invalid MT5 bridge credential.")
    ws = web.WebSocketResponse(heartbeat=None, max_msg_size=4_000_000)
    await ws.prepare(request)
    await relay.attach(ws, bridge_id)
    await store.auth_event("BRIDGE_OK", bridge_id)
    log.info("MT5 bridge link %s connected", bridge_id)
    why = "closed"
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                await relay.on_message(msg.data)
            elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                why = "error"
                break
    finally:
        relay.detach(ws, why)
        log.info("MT5 bridge link %s disconnected (%s)", bridge_id, why)
    return ws


# ------------------------------------------------------------------ IBKR COMEX Level-2 depth (cloud VPS link)
IBKR_ROOT_ERR = "root must be GC or SI."


def _ibkr_root(request: web.Request) -> str | None:
    root = (request.query.get("root") or "GC").upper()
    return root if root in ("GC", "SI") else None


@market_data_route
async def ibkr_status(request: web.Request) -> web.Response:
    return _json(request.app[K_IBKR].status())


def _ibkr_client_seen(request: web.Request) -> None:
    # Diagnostics only: when a browser last read IBKR depth (proves recording does not depend on a viewer).
    request.app[K_STATE]["ibkrClientMs"] = int(time.time() * 1000)


@market_data_route
async def ibkr_book(request: web.Request) -> web.Response:
    _ibkr_client_seen(request)
    root = _ibkr_root(request)
    if root is None:
        return _err(400, "BAD_ROOT", IBKR_ROOT_ERR)
    return _json(request.app[K_IBKR].book(root))


@market_data_route
async def ibkr_updates(request: web.Request) -> web.Response:
    _ibkr_client_seen(request)
    root = _ibkr_root(request)
    if root is None:
        return _err(400, "BAD_ROOT", IBKR_ROOT_ERR)
    try:
        epoch, after = int(request.query.get("epoch", "-1")), int(request.query.get("after", "-1"))
    except ValueError:
        return _err(400, "BAD_QUERY", "epoch and after must be integers.")
    return _json(request.app[K_IBKR].updates(root, epoch, after))


def _ibkr_contract(request: web.Request, root: str) -> str | None:
    relay = request.app[K_IBKR]
    c = relay.books[root].contract or {}
    # The heatmap history is the contract Databento is trading (targets) - expiries are never mixed.
    return relay.targets.get(root) or c.get("localSymbol") or None


@market_data_route
async def ibkr_history_status(request: web.Request) -> web.Response:
    """Server-side IBKR depth recording: first recorded time, observations, duration, persistence (no data values)."""
    rec, store = request.app[K_DEPTH], request.app[K_STORE]
    try:
        size = await store.depth_bytes()
    except Exception:  # noqa: BLE001
        size = None
    relay = request.app[K_IBKR]
    st = relay.status()
    gaps = {}
    for r in ("GC", "SI"):
        c = _ibkr_contract(request, r)
        try:
            gaps[r] = [{"t": g["t"], **{k: v for k, v in json.loads(g["data"]).items() if k in ("reason", "i")}} for g in await store.depth_gaps(r, c or "")]
        except Exception:  # noqa: BLE001
            gaps[r] = None
    feed = {r: {k: st["roots"][r].get(k) for k in ("state", "detail", "lastUpdateMs", "polls", "depthSeq", "bidLevels", "askLevels", "outOfOrder", "malformed", "receiveLagMs")} for r in ("GC", "SI")}
    return _json({**rec.status(), "persistence": getattr(store, "kind", "unknown"), "tableBytes": size, "serverMs": int(time.time() * 1000),
                  "lastBrowserDepthReadMs": request.app[K_STATE].get("ibkrClientMs"), "streamClients": len(request.app[K_HUB].clients),
                  "ibkrFeed": feed, "recentGaps": gaps, "ibkrSession": {k: st["session"].get(k) for k in ("state", "apiConnected", "reconnects")},
                  "retentionDays": request.app[K_CFG].ibkr_depth_retention_days, "provider": "Interactive Brokers", "depthType": "PRICE_LEVEL", "mbo": False,
                  "timestampSource": "IBKR bridge receive time (lastUpdate, UTC) - not an exchange timestamp",
                  "contracts": {r: _ibkr_contract(request, r) for r in ("GC", "SI")}})


@market_data_route
async def ibkr_heatmap(request: web.Request) -> web.Response:
    """Recorded IBKR price-level liquidity as a time x price matrix (time-weighted displayed size per bucket).
    Only time covered by recorded observations appears; nothing before the first recorded snapshot."""
    root = _ibkr_root(request)
    if root is None:
        return _err(400, "BAD_ROOT", IBKR_ROOT_ERR)
    try:
        now = int(time.time() * 1000)
        to_ms = int(request.query.get("to", str(now)))
        from_ms = int(request.query.get("from", str(to_ms - 15 * 60_000)))
        bucket = int(request.query.get("bucket", "1000"))
    except ValueError:
        return _err(400, "BAD_QUERY", "from, to and bucket must be integers (ms).")
    rec = request.app[K_DEPTH]
    contract = _ibkr_contract(request, root)
    first = rec.first_ms(root, contract) if contract else None
    base = {"root": root, "contract": contract, "provider": "Interactive Brokers", "depthType": "PRICE_LEVEL", "mbo": False,
            "firstRecordedMs": first, "timestampSource": "IBKR bridge receive time", "persistence": getattr(request.app[K_STORE], "kind", "unknown")}
    req = normalize_request(from_ms, to_ms, bucket, first, now)
    if req is None:
        return _json({**base, "bucketMs": bucket, "from": from_ms, "to": to_ms, "columns": [], "lastObservedMs": None})
    f, t, b = req
    try:
        rows = await rec.rows(root, contract, f, t)
    except Exception as exc:  # noqa: BLE001
        log.warning("IBKR depth history read failed (%s)", type(exc).__name__)
        return _err(503, "HISTORY_UNAVAILABLE", "Recorded depth history is temporarily unavailable.")
    m = await asyncio.get_running_loop().run_in_executor(None, build_matrix, rows, f, t, b)
    return _json({**base, "bucketMs": b, "from": f, "to": t, **m})


async def _depth_history_worker(app: web.Application) -> None:
    """Persist recorded IBKR depth every second (independent of browsers); prune past the retention hourly."""
    rec, cfg = app[K_DEPTH], app[K_CFG]
    last_prune = 0.0
    while True:
        try:
            await asyncio.sleep(1)
            await rec.flush(int(time.time() * 1000))
            if time.time() - last_prune > 3600:
                last_prune = time.time()
                n = await app[K_STORE].prune_depth(int((time.time() - cfg.ibkr_depth_retention_days * 86400) * 1000))
                if n:
                    log.info("IBKR depth history: pruned %d rows older than %d days", n, cfg.ibkr_depth_retention_days)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.error("IBKR depth history worker error")


async def ibkr_bridge_ws(request: web.Request) -> web.StreamResponse:
    cfg, relay, store = request.app[K_CFG], request.app[K_IBKR], request.app[K_STORE]
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else ""
    bridge_id = (request.headers.get("X-TLUXE-Bridge-Id") or "ibkr-vps")[:64]
    if relay.pull or not token_ok(token, cfg.ibkr_bridge_keys):
        relay.counts["authRejected"] += 1
        await store.auth_event("IBKR_BRIDGE_REJECTED", bridge_id)
        return _err(401, "UNAUTHORIZED", "Invalid IBKR bridge credential.")
    ws = web.WebSocketResponse(heartbeat=None, max_msg_size=4_000_000)
    await ws.prepare(request)
    await relay.attach(ws, bridge_id)
    await store.auth_event("IBKR_BRIDGE_OK", bridge_id)
    log.info("IBKR depth bridge link %s connected", bridge_id)
    why = "closed"
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                await relay.on_message(msg.data)
            elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                why = "error"
                break
    finally:
        relay.detach(ws, why)
        log.info("IBKR depth bridge link %s disconnected (%s)", bridge_id, why)
    return ws


async def _ibkr_worker(app: web.Application) -> None:
    """Every 5 s: link heartbeat / stale check, and the target contracts = the ACTIVE Databento contract per root, so
    IBKR depth and Databento trades are always the same expiry (never mixed across a roll)."""
    cfg, relay = app[K_CFG], app[K_IBKR]
    while True:
        try:
            await asyncio.sleep(5)
            if relay.ws is None and not relay.pull:
                continue
            targets: dict[str, str] = {}
            if cfg.databento.configured:
                s, h, _ = await _upstream_get(app, cfg.databento, "/v1/health", 5)
                for root in ("GC", "SI"):
                    c = (((h or {}).get("instruments") or {}).get(root) or {}).get("contract") if s == 200 else None
                    if isinstance(c, str) and c:
                        targets[root] = c
            relay.targets = {r: t for r, t in targets.items() if r in ("GC", "SI") and t}
            await relay.tick(targets)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("ibkr worker")


IBKR_PULL_EVERY_S = 0.25  # measured production experiment (was 0.5): fewer book changes coalesced per observation
IBKR_PULL_TIMEOUT_S = 3.0
IBKR_PULL_MAX_BYTES = 512_000


async def _ibkr_pull_once(app: web.Application, root: str) -> str:
    """One authenticated GET of the VPS depth service for GC or SI (never XAUUSD / XAGUSD). The bearer token is attached
    here, server-side only; nothing about the request (URL, headers, token, upstream body) is logged or returned.
    Returns the outcome kind ("ok" | "http" | "timeout" | "offline" | "malformed") for state-change logging."""
    up, relay = app[K_CFG].ibkr_depth, app[K_IBKR]
    try:
        async with app[K_HTTP].get(f"{up.url}/depth/{root}", headers={"Authorization": f"Bearer {up.token.reveal()}", "Accept": "application/json", "User-Agent": f"TLUXE-Gateway/{__version__}"},
                                   timeout=ClientTimeout(total=IBKR_PULL_TIMEOUT_S), allow_redirects=False) as r:
            if r.status != 200:
                relay.ingest_error(root, "http", r.status)
                return f"http {r.status}"
            raw = await r.content.read(IBKR_PULL_MAX_BYTES + 1)
    except asyncio.TimeoutError:
        relay.ingest_error(root, "timeout")
        return "timeout"
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 - connection refused / DNS / TLS: reported as unreachable, the message is never kept
        relay.ingest_error(root, "offline")
        return "offline"
    try:
        if len(raw) > IBKR_PULL_MAX_BYTES:
            raise ValueError("too large")
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        relay.ingest_error(root, "malformed")
        return "malformed"
    await relay.ingest(root, body)
    return "ok" if relay.pulls[root].errors == 0 else "malformed"


async def _ibkr_depth_poller(app: web.Application, root: str) -> None:
    """Pull mode: poll https://<depth service>/depth/<root> sequentially (one request in flight per root, so responses
    cannot interleave; an older lastUpdate is additionally rejected by the relay)."""
    last = None
    while True:
        try:
            kind = await _ibkr_pull_once(app, root)
            if kind != last:
                log.info("IBKR depth %s: %s (%s)", root, app[K_IBKR].root_state(root)[0], kind)
                last = kind
        except asyncio.CancelledError:
            raise
        except Exception:
            log.error("IBKR depth %s poller error", root)  # no traceback: it could carry request details
        await asyncio.sleep(IBKR_PULL_EVERY_S)


# ------------------------------------------------------------------ background workers
async def _status_worker(app: web.Application) -> None:
    last_states: dict[str, str] = {}
    last_push = 0.0
    wake = asyncio.Event()
    app[K_HUB].on_clients_changed = wake.set  # a new / closed browser stream refreshes the status immediately
    while True:
        wake.clear()
        try:
            st = await compute_status(app)
            app[K_STATE]["previousStatus"] = app[K_STATE].get("status")
            app[K_STATE]["status"] = st
            changed = False
            for name, c in st["components"].items():
                if last_states.get(name) != c["state"]:
                    changed = True
                    last_states[name] = c["state"]
                    await app[K_STORE].record_status("provider" if name in ("openai", "databento", "news", "mt5Feed") else "service", name, c["state"], c.get("detail"), c.get("marketOpen"))
            if changed or time.time() - last_push > 30:
                app[K_HUB].publish("status", st, remember=True)
                last_push = time.time()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("status worker")
        try:
            await asyncio.wait_for(wake.wait(), 10)
        except asyncio.TimeoutError:
            pass


async def _databento_worker(app: web.Application) -> None:
    """Server-side Databento follow: only while a browser subscribes; frames pushed over the stream."""
    cfg, hub = app[K_CFG], app[K_HUB]
    cursor, last_health = 0, 0.0
    while True:
        try:
            if not cfg.databento.configured or hub.subscribers("databento") == 0:
                cursor = 0
                await asyncio.sleep(1.0)
                continue
            if time.time() - last_health > 2:
                s, h, _ = await _upstream_get(app, cfg.databento, "/v1/health", 5)
                if s == 200 and h:
                    msg = {"kind": "health", "health": h}
                    hub.last["databento-health"] = msg
                    hub.publish("databento", msg)
                    if not cursor:
                        cursor = int((h.get("metrics") or {}).get("cursor") or 0)
                last_health = time.time()
            s, page, _ = await _upstream_get(app, cfg.databento, f"/v1/feed?cursor={cursor}", 5)
            if s == 200 and page:
                if page.get("reset"):
                    hub.publish("databento", {"kind": "reset", "cursor": page.get("cursor")})
                elif page.get("frames"):
                    hub.publish("databento", {"kind": "frames", "cursor": page.get("cursor"), "frames": page["frames"]})
                cursor = int(page.get("cursor") or cursor)
            await asyncio.sleep(0.25)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("databento worker")
            await asyncio.sleep(2)


async def _news_worker(app: web.Application) -> None:
    """Persist normalized news to PostgreSQL and notify browsers of new / revised items (no browser polling)."""
    cfg, store, hub = app[K_CFG], app[K_STORE], app[K_HUB]
    seqs = {"calendar": 0, "macro": 0, "breaking": 0}
    started = None
    while True:
        try:
            if cfg.news.configured:
                s, h, _ = await _upstream_get(app, cfg.news, "/v1/health", 6)
                if s == 200 and h:
                    if started is not None and h.get("startedAtMs") != started:
                        seqs = {k: 0 for k in seqs}  # news service restarted
                    started = h.get("startedAtMs")
                    changed = {}
                    s2, page, _ = await _upstream_get(app, cfg.news, f"/v1/calendar?since={seqs['calendar']}&limit=2000", 15)
                    if s2 == 200 and page:
                        for e in page.get("events") or []:
                            await store.upsert_calendar(e)
                        if page.get("events"):
                            changed["calendar"] = page.get("seq")
                        seqs["calendar"] = int(page.get("seq") or 0)
                    for feed in ("macro", "breaking"):
                        s3, hp, _ = await _upstream_get(app, cfg.news, f"/v1/headlines?feed={feed}&since={seqs[feed]}&limit=500", 15)
                        if s3 == 200 and hp:
                            for x in hp.get("headlines") or []:
                                await store.upsert_headline(x)
                            if hp.get("headlines"):
                                changed[feed] = hp.get("seq")
                            seqs[feed] = int(hp.get("seq") or 0)
                    if changed:
                        hub.publish("news", {"changed": changed, "feeds": {k: (v or {}).get("status") for k, v in (h.get("feeds") or {}).items()}})
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("news worker")
        await asyncio.sleep(15)


async def _mt5_heartbeat_worker(app: web.Application) -> None:
    while True:
        try:
            await app[K_RELAY].heartbeat()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("mt5 heartbeat")
        await asyncio.sleep(MT5_HB_S)


async def _retention_worker(app: web.Application) -> None:
    while True:
        try:
            await app[K_STORE].retention()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("retention")
        await asyncio.sleep(24 * 3600)


# ------------------------------------------------------------------ app factory
def make_app(cfg: GatewayConfig, store=None, workers: bool = True, http_session_factory=None) -> web.Application:
    app = web.Application(middlewares=[security], client_max_size=MAX_JSON)
    app[K_CFG] = cfg
    app[K_STORE] = store or (PgStore(cfg.database_url.reveal()) if cfg.database_url else MemoryStore())
    app[K_HUB] = StreamHub()
    app[K_STATE] = {"limiter": LoginLimiter(), "globalLimiter": GlobalFailLimiter(), "publicLimiter": PublicRateLimiter(), "tasks": []}

    async def on_integrity(kind: str, detail: dict) -> None:
        await app[K_STORE].add_integrity("mt5", None, kind, detail)

    app[K_RELAY] = Mt5Relay(cfg.mt5_bridge_keys, on_integrity)
    # Pull mode (the VPS depth service) takes precedence over the older inbound VPS link: one depth source per book.
    pull = cfg.ibkr_depth.configured
    app[K_IBKR] = IbkrRelay(() if pull else cfg.ibkr_bridge_keys, pull=pull)
    app[K_DEPTH] = DepthRecorder(app[K_STORE])
    if pull:
        app[K_IBKR].recorder = app[K_DEPTH]

    async def startup(app: web.Application) -> None:
        if cfg.production and isinstance(app[K_STORE], MemoryStore):
            raise RuntimeError("production requires PostgreSQL (DATABASE_URL)")
        await app[K_STORE].open()
        applied = await app[K_STORE].migrate()
        if applied:
            log.info("migrations applied: %s", ", ".join(applied))
        # Survive restarts truthfully: the last recorded status is shown as "previous", never as current LIVE.
        app[K_STATE]["previousStatus"] = {"restoredFromDatabase": True, "components": await app[K_STORE].last_statuses()}
        app[K_HTTP] = (http_session_factory or ClientSession)()
        if workers:
            for w in (_status_worker, _databento_worker, _news_worker, _mt5_heartbeat_worker, _retention_worker, _ibkr_worker):
                app[K_STATE]["tasks"].append(asyncio.create_task(w(app)))
            if cfg.ibkr_depth.configured:
                await app[K_DEPTH].load_stats()
                app[K_STATE]["tasks"].append(asyncio.create_task(_depth_history_worker(app)))
                for root in ("GC", "SI"):  # IBKR depth is COMEX GC / SI only - XAUUSD / XAGUSD are never routed here
                    app[K_STATE]["tasks"].append(asyncio.create_task(_ibkr_depth_poller(app, root)))

    async def shutdown(app: web.Application) -> None:
        log.info("gateway shutting down gracefully")
        await app[K_HUB].close_all()
        if app[K_RELAY].ws is not None:
            await app[K_RELAY].ws.close(code=1001, message=b"server shutting down")
        if app[K_IBKR].ws is not None:
            await app[K_IBKR].ws.close(code=1001, message=b"server shutting down")

    async def cleanup(app: web.Application) -> None:
        for t in app[K_STATE]["tasks"]:
            t.cancel()
        await asyncio.gather(*app[K_STATE]["tasks"], return_exceptions=True)
        if cfg.ibkr_depth.configured:
            for r in ("GC", "SI"):
                app[K_DEPTH].gap(r, "gateway stopped")  # a restart never bridges the book across the downtime
            try:
                await app[K_DEPTH].flush(int(time.time() * 1000))
            except Exception:  # noqa: BLE001
                log.error("IBKR depth history final flush failed")
        if K_HTTP in app:
            await app[K_HTTP].close()
        await app[K_STORE].close()

    app.on_startup.append(startup)
    app.on_shutdown.append(shutdown)
    app.on_cleanup.append(cleanup)

    r = app.router
    r.add_get("/healthz", healthz)
    r.add_get("/readyz", readyz)
    r.add_get("/api/config", runtime_config)
    r.add_post("/api/auth/login", login)
    r.add_post("/api/auth/logout", logout)
    r.add_get("/api/auth/me", me)
    r.add_get("/api/status", status_route)
    r.add_get("/api/stream", stream_ws)
    r.add_get("/bridge/mt5", bridge_ws)
    r.add_get("/bridge/ibkr", ibkr_bridge_ws)
    r.add_get("/api/ibkr/status", ibkr_status)
    r.add_get("/api/ibkr/book", ibkr_book)
    r.add_get("/api/ibkr/updates", ibkr_updates)
    r.add_get("/api/ibkr/heatmap", ibkr_heatmap)
    r.add_get("/api/ibkr/history", ibkr_history_status)
    r.add_get("/api/ai/health", ai_health)
    r.add_post("/api/ai/chat", ai_chat)
    r.add_get("/api/databento/status", databento_status)
    r.add_get("/api/databento/{path:.+}", databento_proxy)
    r.add_get("/api/news/{path:.+}", news_proxy)
    r.add_route("*", "/api/mt5/{path:.+}", mt5_proxy)
    r.add_post("/api/alerts", post_alert)
    r.add_post("/api/snapshots", post_snapshot)

    async def api_404(request: web.Request) -> web.Response:
        return _err(404, "NOT_FOUND", "Unknown endpoint.")

    r.add_route("*", "/api/{tail:.*}", api_404)
    if cfg.static_dir and Path(cfg.static_dir).is_dir():
        root = Path(cfg.static_dir).resolve()

        async def spa(request: web.Request) -> web.StreamResponse:
            rel = request.match_info.get("tail", "")
            f = (root / rel).resolve()
            if rel and f.is_file() and root in f.parents:
                resp = web.FileResponse(f)
                if "/assets/" in f"/{rel}":
                    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
                return resp
            resp = web.FileResponse(root / "index.html")
            resp.headers["Cache-Control"] = "no-cache"
            return resp

        r.add_get("/{tail:.*}", spa)
    return app


def redactor_for(cfg: GatewayConfig) -> Redactor:
    return Redactor(*cfg.secrets(), *(urlparse(cfg.database_url.reveal()).password or "",))
