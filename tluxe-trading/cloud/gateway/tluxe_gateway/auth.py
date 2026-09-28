"""Owner authentication for the public TLUXE deployment.

No static shared secret in the browser: the owner logs in with a password (verified against a salted hash kept in
the platform's secret variables - scrypt, or PBKDF2-HMAC-SHA256 with >= 600,000 iterations, which the offline
generator tools/owner-password-hash.html produces with the browser's WebCrypto), receives a random session id in an HttpOnly, SameSite=Strict (and Secure in
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
PBKDF2_MIN_ITERATIONS = 600_000
PBKDF2_ITERATIONS = 600_000
GLOBAL_FAILS_PER_MIN = 30  # all clients together: a distributed guessing attempt is slowed down as well


def hash_password(password: str, n: int = 2**15, r: int = 8, p: int = 1) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, maxmem=256 * 1024 * 1024, dklen=32)
    return f"scrypt${n}${r}${p}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def hash_password_pbkdf2(password: str, iterations: int = PBKDF2_ITERATIONS) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations, dklen=32)
    return f"pbkdf2_sha256${iterations}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        parts = stored.split("$")
        if parts[0] == "scrypt" and len(parts) == 6:
            _, n, r, p, salt_b64, dk_b64 = parts
            salt, expected = base64.b64decode(salt_b64), base64.b64decode(dk_b64)
            dk = hashlib.scrypt(password.encode(), salt=salt, n=int(n), r=int(r), p=int(p), maxmem=256 * 1024 * 1024, dklen=len(expected))
        elif parts[0] == "pbkdf2_sha256" and len(parts) == 4:
            _, it, salt_b64, dk_b64 = parts
            salt, expected = base64.b64decode(salt_b64), base64.b64decode(dk_b64)
            if int(it) < PBKDF2_MIN_ITERATIONS or len(salt) < 16 or len(expected) < 32:
                return False
            dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(it), dklen=len(expected))
        else:
            return False
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


class GlobalFailLimiter:
    """Failed logins across ALL clients in a sliding minute. Above the cap, every login is refused for the rest of the
    minute (a short, self-healing pause - never a permanent owner lock-out)."""

    def __init__(self, cap: int = GLOBAL_FAILS_PER_MIN, clock=time.monotonic) -> None:
        self.cap, self.clock = cap, clock
        self.times: list[float] = []

    def _trim(self) -> None:
        cut = self.clock() - 60
        self.times = [t for t in self.times if t > cut]

    def blocked(self) -> float:
        self._trim()
        return max(0.0, self.times[0] + 60 - self.clock()) if len(self.times) >= self.cap else 0.0

    def fail(self) -> None:
        self._trim()
        self.times.append(self.clock())
