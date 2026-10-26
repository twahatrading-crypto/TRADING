"""Authentication for the HLR Original page - SEPARATE from this app's owner login.

The rest of Trading by TLUXE stays publicly accessible exactly as it is: `TLUXE_OWNER_PASSWORD_HASH`
remains unset, so `public_market_data` stays true and `main.tsx` never renders its sign-in screen.
Only `/hlr-original/*` and `/api/hlr/*` are gated, by this credential and nothing else.

FOUR PROPERTIES WORTH READING BEFORE CHANGING ANYTHING HERE.

1. The two session kinds cannot be confused. Both live in the shipped session store, but the stored
   key is a hash over a different input domain: the owner's is `sha256(sid)`, this one is
   `sha256("tluxe-hlr-v1" | password-fingerprint | sid)`. An owner cookie therefore hashes to a key
   that was never stored for HLR, and an HLR cookie to one never stored for the owner. Neither
   `auth.py` nor `store.py` is touched.

2. Rotating the password invalidates every existing HLR session, with no revocation list. The key
   includes a fingerprint of the password hash, so changing `TLUXE_HLR_PASSWORD_HASH` makes every
   previously issued key unresolvable. Sessions do not survive a rotation; that is the point.

3. Rate limiting never trusts a spoofable header to GRANT anything. `X-Forwarded-For`'s last hop is
   set by Railway's proxy and a client cannot forge it, but behind Cloudflare it is the same edge
   address for everyone. `CF-Connecting-IP` identifies the real caller - and is forgeable by anyone
   reaching the origin directly. So both are counted, and a caller is refused if EITHER bucket is
   locked. A forged header can only ever add restriction; it can never lift one, and it cannot lock
   anyone else out of the unforgeable bucket.

4. Fail closed. With no password configured the routes are never registered, so the page and its APIs
   do not exist.
"""
from __future__ import annotations

import hashlib
import time

from aiohttp import web

from .auth import LoginLimiter, new_session_id, sid_hash, verify_password

#: Distinct from the owner cookie (`tluxe_session`) so neither can be presented as the other.
HLR_COOKIE = "tluxe_hlr"
#: Domain separator. Bump if the session format ever changes; every live session is invalidated.
_DOMAIN = "tluxe-hlr-v1"


def password_fingerprint(password_hash: str) -> str:
    """A short, non-reversible marker of WHICH password is configured.

    Mixed into every session key so a password rotation invalidates previous sessions. It is derived
    from the stored hash - never from the password - and is never sent anywhere.
    """
    return hashlib.sha256(password_hash.encode()).hexdigest()[:16]


def hlr_session_key(sid: str, password_hash: str) -> str:
    """The store key for an HLR session. NUL-joined so no field can run into the next one."""
    return sid_hash("\0".join((_DOMAIN, password_fingerprint(password_hash), sid)))


class DualLimiter:
    """Failed-attempt lock-out counted against two buckets at once (see property 3 above).

    `peer` is the unforgeable one. `claimed` is whatever the caller says it is, and is honoured only
    to make the limit FINER, never looser.
    """

    def __init__(self, clock=time.monotonic) -> None:
        self.peer = LoginLimiter(clock)
        self.claimed = LoginLimiter(clock)

    @staticmethod
    def keys(request: web.Request) -> tuple[str, str | None]:
        xff = request.headers.get("X-Forwarded-For", "")
        peer = xff.split(",")[-1].strip() if xff else (request.remote or "?")
        cf = (request.headers.get("CF-Connecting-IP") or "").strip()[:64]
        return peer or "?", (cf or None)

    def locked(self, request: web.Request) -> float:
        peer, cf = self.keys(request)
        wait = self.peer.locked(peer)
        if cf:
            wait = max(wait, self.claimed.locked(cf))
        return wait

    def fail(self, request: web.Request) -> None:
        peer, cf = self.keys(request)
        self.peer.fail(peer)
        if cf:
            self.claimed.fail(cf)

    def ok(self, request: web.Request) -> None:
        peer, cf = self.keys(request)
        self.peer.ok(peer)
        if cf:
            self.claimed.ok(cf)


def set_cookie(resp: web.StreamResponse, cfg, sid: str) -> None:
    resp.set_cookie(HLR_COOKIE, sid, max_age=cfg.session_ttl_s, httponly=True,
                    secure=cfg.cookie_secure, samesite="Strict", path="/")


def clear_cookie(resp: web.StreamResponse) -> None:
    resp.del_cookie(HLR_COOKIE, path="/")


async def current_session(request: web.Request, cfg, store) -> str | None:
    """The caller's HLR session id, or None. Returns None whenever HLR auth is not configured."""
    secret = cfg.hlr_password_hash.reveal()
    if not secret:
        return None
    sid = request.cookies.get(HLR_COOKIE)
    if not sid or len(sid) > 200:
        return None
    return sid if await store.session_valid(hlr_session_key(sid, secret)) else None


def build(cfg, store_of, err, json_of, limiter_of):
    """Build the three auth handlers and the gate.

    Everything the gateway owns is passed in rather than imported, so this module cannot drift into
    the shared auth path: it has no access to the owner cookie, the owner hash or their limiters.
    """

    def require_hlr_session(fn):
        async def wrapped(request: web.Request):
            sid = await current_session(request, cfg, store_of(request))
            if sid is None:
                return err(401, "HLR_UNAUTHORIZED", "Sign in to open HLR Original.")
            # State-changing requests must come from the app itself (CSRF; mirrors the owner gate).
            if request.method != "GET" and request.headers.get("Origin") is None and cfg.production:
                return err(403, "ORIGIN_REQUIRED", "State-changing requests must come from the TLUXE web app.")
            return await fn(request)

        return wrapped

    async def login(request: web.Request) -> web.Response:
        secret = cfg.hlr_password_hash.reveal()
        limiter = limiter_of(request)
        wait = limiter.locked(request)
        if wait > 0:
            return err(429, "RATE_LIMITED", f"Too many attempts - wait {int(wait)}s.")
        if request.headers.get("Origin") is None and cfg.production:
            return err(403, "ORIGIN_REQUIRED", "Sign-in must come from the TLUXE web app.")
        try:
            body = await request.json()
        except (ValueError, UnicodeDecodeError):
            return err(400, "INVALID_JSON", "Invalid JSON.")
        password = body.get("password") if isinstance(body, dict) else None
        if not isinstance(password, str) or not password or len(password) > 512:
            limiter.fail(request)
            return err(401, "INVALID_CREDENTIALS", "Sign-in failed.")
        import asyncio

        ok = await asyncio.get_running_loop().run_in_executor(None, verify_password, password, secret)
        if not ok:
            limiter.fail(request)
            return err(401, "INVALID_CREDENTIALS", "Sign-in failed.")
        limiter.ok(request)
        sid = new_session_id()
        await store_of(request).session_create(hlr_session_key(sid, secret), cfg.session_ttl_s)
        resp = json_of({"ok": True})
        set_cookie(resp, cfg, sid)
        return resp

    async def logout(request: web.Request) -> web.Response:
        """Revokes immediately: the stored key is deleted, so the cookie is dead even if kept."""
        secret = cfg.hlr_password_hash.reveal()
        sid = request.cookies.get(HLR_COOKIE)
        if sid and secret and len(sid) <= 200:
            await store_of(request).session_revoke(hlr_session_key(sid, secret))
        resp = json_of({"ok": True})
        clear_cookie(resp)
        return resp

    async def me(request: web.Request) -> web.Response:
        sid = await current_session(request, cfg, store_of(request))
        if sid is None:
            return err(401, "HLR_UNAUTHORIZED", "Sign in to open HLR Original.")
        return json_of({"authenticated": True, "scope": "hlr-original", "readOnly": True})

    return require_hlr_session, login, logout, me
