"""TEST DATA ONLY - records shaped like the DOCUMENTED Trading Economics payloads (field names from the official API
docs). Values are fabricated for tests and are never used by the running backend; no network is used."""
from __future__ import annotations

import json

from tluxe_news_bridge.config import from_env

FAKE_TE_KEY = "testclientABC123:testsecretXYZ789"
TOKEN = "n" * 40


def cfg(**over):
    env = {"TRADING_ECONOMICS_API_KEY": FAKE_TE_KEY, "TLUXE_NEWS_TOKEN": TOKEN, **over}
    return from_env({k: v for k, v in env.items() if v is not None})


def te_event(cid="330001", event="Core Inflation Rate YoY", date="2026-10-14T12:30:00", importance=3, actual="", forecast="3.1%",
             previous="3.2%", revised="", country="United States", currency="USD", category="Core Inflation Rate", last_update="2026-10-13T09:00:00", **extra):
    rec = {"CalendarId": cid, "Date": date, "Country": country, "Category": category, "Event": event, "Reference": "Sep",
           "ReferenceDate": "2026-09-30T00:00:00", "Source": "U.S. Bureau of Labor Statistics", "SourceURL": "https://www.bls.gov",
           "Actual": actual, "Previous": previous, "Forecast": forecast, "TEForecast": "3.1%", "URL": "/united-states/core-inflation-rate",
           "DateSpan": "0", "Importance": importance, "LastUpdate": last_update, "Revised": revised, "Currency": currency, "Unit": "%",
           "Ticker": "USACIR", "Symbol": "USACIR"}
    rec.update(extra)
    return rec


def te_news(nid="9001", title="TEST DATA headline", date="2026-10-14T13:00:00", importance=2):
    return {"id": nid, "title": title, "date": date, "description": "TEST DATA description", "country": "United States",
            "category": "Inflation Rate", "symbol": "CPI YOY", "url": "/united-states/inflation-cpi", "importance": importance}


class FakeHttp:
    """Scripted HTTP GET for the REST client. `routes`: path-prefix -> (status, payload) or callable."""

    def __init__(self, routes: dict | None = None, raise_exc: Exception | None = None) -> None:
        self.routes = routes or {}
        self.raise_exc = raise_exc
        self.urls: list[str] = []

    def __call__(self, url: str, timeout: float):
        self.urls.append(url)
        if self.raise_exc:
            raise self.raise_exc
        path = url.split("api.tradingeconomics.com", 1)[-1].split("?", 1)[0]
        for prefix, resp in self.routes.items():
            if path.startswith(prefix):
                status, payload = resp() if callable(resp) else resp
                return status, payload if isinstance(payload, str) else json.dumps(payload)
        return 404, "{}"


class Clock:
    def __init__(self, t: float) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t
