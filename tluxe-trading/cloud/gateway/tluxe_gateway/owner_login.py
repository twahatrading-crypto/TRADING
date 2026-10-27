"""Whole-site owner sign-in: the pieces app.py wires in (no route registration here).

Active only when the owner login is configured (TLUXE_OWNER_PASSWORD_HASH set -> cfg.public_market_data is
False). Without it the site behaves exactly as before. With it:

  * nothing private is served without a valid owner session - not the dashboard HTML, not its JavaScript
    bundles, not market data, not the browser WebSocket. Page navigations are redirected to /login; any other
    request gets 401. Files that were served are marked `private` so Cloudflare never stores them for others.
  * /login is a small self-contained page shipped with the gateway (login_page/), so the sign-in screen can be
    shown without handing out any of the dashboard's code.
  * the password is checked against a salted scrypt / PBKDF2 hash only. After a change made in the web app the
    new hash lives in Postgres (owner_credential); TLUXE_OWNER_PASSWORD_HASH stays the bootstrap value and a
    break-glass reset - putting a NEW hash there makes the stored one stale (its fingerprint no longer matches).
"""
from __future__ import annotations

import hashlib
import hmac
import re
from pathlib import Path
from urllib.parse import quote

from aiohttp import web

LOGIN_DIR = Path(__file__).resolve().parent / "login_page"
#: The ONLY files /login/assets/ serves (no directory walking, no other file of the package).
LOGIN_ASSETS = {"login.css": "text/css", "login.js": "application/javascript", "mark.svg": "image/svg+xml"}
MIN_PASSWORD = 12
MAX_PASSWORD = 256
_ASSET_EXT = re.compile(r"\.[A-Za-z0-9]{1,8}$")


def env_fingerprint(env_hash: str) -> str:
    """Ties a stored credential to the bootstrap hash it replaced (sha256 of the hash string - not a secret)."""
    return hashlib.sha256(("tluxe-owner-v1\x00" + env_hash).encode()).hexdigest()


async def effective_hash(cfg, store) -> str:
    """The hash a sign-in is checked against: the web-app-changed one while it still belongs to the current
    bootstrap hash, otherwise the bootstrap hash from the environment."""
    env_hash = cfg.owner_password_hash.reveal()
    try:
        cred = await store.owner_credential_get()
    except Exception:  # noqa: BLE001 - a database outage never opens anything: the bootstrap hash still applies
        cred = None
    if cred and hmac.compare_digest(cred[1], env_fingerprint(env_hash)):
        return cred[0]
    return env_hash


def email_ok(given: object, owner_email: str) -> bool:
    if not owner_email or not isinstance(given, str) or len(given) > 254:
        return False
    return hmac.compare_digest(given.strip().lower().encode(), owner_email.encode())


def password_problem(new: object, current: str, email: str) -> str | None:
    """Policy for a NEW password (the bootstrap one is chosen offline by the owner)."""
    if not isinstance(new, str) or not (MIN_PASSWORD <= len(new) <= MAX_PASSWORD):
        return f"The new password must be {MIN_PASSWORD} to {MAX_PASSWORD} characters."
    if new == current:
        return "The new password must differ from the current one."
    if email and new.strip().lower() == email:
        return "The new password must not be your e-mail address."
    if len(set(new)) < 6:
        return "The new password is too simple."
    return None


def safe_next(raw: str | None) -> str:
    """Only a same-site path may be the post-sign-in destination (no //host, no scheme, no backslash tricks, and no
    whitespace / control characters - browsers drop tab and newline, so "/<TAB>/evil.example" would become //evil.example)."""
    if not raw or not raw.startswith("/") or raw.startswith("//") or "\\" in raw or len(raw) > 500 or raw.startswith("/login") \
            or any(ord(ch) <= 0x20 or ord(ch) == 0x7F for ch in raw):
        return "/"
    return raw


def is_page_request(request: web.Request) -> bool:
    """A browser navigation (HTML) rather than a script / style / image / data request."""
    if _ASSET_EXT.search(request.path) and not request.path.endswith(".html"):
        return False
    accept = request.headers.get("Accept", "")
    return request.method == "GET" and ("text/html" in accept or not accept or "*/*" == accept.strip())


def deny(request: web.Request) -> web.StreamResponse:
    """No owner session: navigate to the sign-in page, or refuse (never a cached / partial answer)."""
    if is_page_request(request):
        target = request.path_qs if request.path != "/" else ""
        resp = web.HTTPFound("/login" + (f"?next={quote(target, safe='/')}" if target else ""))
    else:
        resp = web.Response(status=401, text="Sign in to TLUXE.", content_type="text/plain")
    resp.headers["Cache-Control"] = "no-store, private, max-age=0"
    resp.headers["Vary"] = "Cookie"
    return resp


def mark_private(resp: web.StreamResponse, immutable: bool) -> web.StreamResponse:
    """Signed-in content: browsers may keep it, Cloudflare (a shared cache) never does."""
    resp.headers["Cache-Control"] = "private, max-age=31536000, immutable" if immutable else "private, no-store, max-age=0"
    resp.headers["Vary"] = "Cookie"
    return resp


def login_page_response() -> web.StreamResponse:
    resp = web.FileResponse(LOGIN_DIR / "login.html")
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    resp.content_type = "text/html"
    return resp


def login_asset_response(name: str) -> web.StreamResponse:
    if name not in LOGIN_ASSETS:
        raise web.HTTPNotFound(text="Not found.")
    resp = web.FileResponse(LOGIN_DIR / name)
    resp.content_type = LOGIN_ASSETS[name]
    resp.headers["Cache-Control"] = "no-cache"
    return resp
