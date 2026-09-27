"""Trading Economics REST client (official API, https://api.tradingeconomics.com). Server-side only.

The credential is passed as the documented `c=` query parameter and is masked in every log / error text.
Errors are classified so the scheduler can back off instead of hammering the API:
  401 -> AUTH · 403 -> ENTITLEMENT (plan does not include this endpoint / country) · 409 / 429 -> RATE_LIMITED ·
  5xx -> PROVIDER_ERROR · transport -> NETWORK.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable

from .config import NewsConfig
from .redact import Redactor

TIMEOUT_S = 20
MAX_BODY = 20_000_000


class TeError(Exception):
    def __init__(self, code: str, message: str, http_status: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


def default_http_get(url: str, timeout: float) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "TLUXE-News/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 - fixed https base URL
            return res.status, res.read(MAX_BODY).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(4096).decode("utf-8", errors="replace")


class TeRestClient:
    def __init__(self, cfg: NewsConfig, http_get: Callable[[str, float], tuple[int, str]] | None = None) -> None:
        self.cfg = cfg
        self.redact = Redactor(cfg.te_key.reveal(), cfg.token.reveal())
        self.http_get = http_get or default_http_get
        self.requests = 0

    def _get(self, path: str, params: dict | None = None) -> list:
        q = {**(params or {}), "c": self.cfg.te_key.reveal(), "f": "json"}
        url = f"{self.cfg.rest_base}{path}?{urllib.parse.urlencode(q)}"
        self.requests += 1
        try:
            status, body = self.http_get(url, TIMEOUT_S)
        except Exception as exc:  # noqa: BLE001 - transport problems are classified, redacted
            raise TeError("NETWORK", f"Trading Economics not reachable ({type(exc).__name__}).") from None
        if status == 401:
            raise TeError("AUTH", "Trading Economics rejected the API credential (check TRADING_ECONOMICS_API_KEY).", status)
        if status == 403:
            raise TeError("ENTITLEMENT", "Your Trading Economics plan does not include this data (HTTP 403).", status)
        if status in (409, 429):
            raise TeError("RATE_LIMITED", "Trading Economics rate limit reached - backing off.", status)
        if status >= 500:
            raise TeError("PROVIDER_ERROR", f"Trading Economics server error (HTTP {status}).", status)
        if status != 200:
            raise TeError("PROVIDER_ERROR", f"Unexpected Trading Economics response (HTTP {status}): {self.redact(body[:160])}", status)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            raise TeError("BAD_PAYLOAD", "Trading Economics returned a non-JSON response.", status) from None
        if isinstance(data, dict):
            msg = str(data.get("Message") or data.get("message") or data)[:200]
            low = msg.lower()
            code = "AUTH" if ("unauthor" in low or "invalid" in low and "key" in low) else "ENTITLEMENT" if ("permission" in low or "subscri" in low or "not allowed" in low) else "BAD_PAYLOAD"
            raise TeError(code, f"Trading Economics: {self.redact(msg)}", status)
        if not isinstance(data, list):
            raise TeError("BAD_PAYLOAD", "Trading Economics returned an unexpected payload.", status)
        return data

    def calendar_window(self, d1: str, d2: str) -> list:
        """/calendar/country/{countries}/{d1}/{d2} - all importances (filtering is presentation logic)."""
        countries = urllib.parse.quote(",".join(self.cfg.countries), safe=",")
        return self._get(f"/calendar/country/{countries}/{d1}/{d2}")

    def calendar_updates(self) -> list:
        """/calendar/updates - the most recently updated calendar rows (actuals / revisions)."""
        return self._get("/calendar/updates")

    def news(self, limit: int = 50) -> list:
        return self._get("/news", {"limit": limit})
