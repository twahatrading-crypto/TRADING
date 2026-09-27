"""Owner authentication for the public TLUXE deployment.

No static shared secret in the browser: the owner logs in with a password (verified against an scrypt hash kept in
the platform's secret variables), receives a random session id in an HttpOnly, SameSite=Strict (and Secure in
production) cookie, and only the SHA-256 of that id is stored. Sessions expire, rotate (re-issued with a new id and
the old one revoked), and can be revoked by logout. Login attempts are rate-limited per client address.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time

COOKIE = "tluxe_session"
ROTATE_AFTER_S = 3600
MAX_FAILS = 5
LOCK_S = 300


def hash_password(password: str, n: int = 2**15, r: int = 8, p: int = 1) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, maxmem=256 * 1024 * 1024, dklen=32)
    return f"scrypt${n}${r}${p}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt_b64, dk_b64 = stored.split("$")
        salt, expected = base64.b64decode(salt_b64), base64.b64decode(dk_b64)
        dk = hashlib.scrypt(password.encode(), salt=salt, n=int(n), r=int(r), p=int(p), maxmem=256 * 1024 * 1024, dklen=len(expected))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk, expected)


def sid_hash(sid: str) -> str:
    return hashlib.sha256(sid.encode()).hexdigest()


def new_session_id() -> str:
    return secrets.token_urlsafe(32)


class LoginLimiter:
    """Per-client failed-attempt counter with a lock-out (in memory; one gateway instance)."""

    def __init__(self, clock=time.monotonic) -> None:
        self.clock = clock
        self.fails: dict[str, tuple[int, float]] = {}

    def locked(self, client: str) -> float:
        n, until = self.fails.get(client, (0, 0.0))
        return max(0.0, until - self.clock()) if n >= MAX_FAILS else 0.0

    def fail(self, client: str) -> None:
        n, _ = self.fails.get(client, (0, 0.0))
        n += 1
        self.fails[client] = (n, self.clock() + LOCK_S * (2 ** max(0, n - MAX_FAILS)) if n >= MAX_FAILS else 0.0)
        if len(self.fails) > 10_000:
            self.fails.clear()

    def ok(self, client: str) -> None:
        self.fails.pop(client, None)
