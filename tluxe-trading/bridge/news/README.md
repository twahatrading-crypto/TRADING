# Trading by TLUXE — News backend (Trading Economics)

```
Trading Economics API (REST + streaming if entitled) → THIS backend (127.0.0.1:8768, bridge token)
  → normalized calendar / headlines → TLUXE News Analysis (engine + UI) → TLUXE AI read-only context
```

**Real provider data only.** No generated headlines, no hard-coded events, no simulated Actual / Forecast / Previous.
Without credentials every feed reports **NOT CONFIGURED** and the News Analysis page shows **DATA UNAVAILABLE**.

| feed | provider | status |
|---|---|---|
| Economic Calendar | Trading Economics calendar API (`/calendar/country/{countries}/{d1}/{d2}`, `/calendar/updates`, streaming topic `calendar`) | needs `TRADING_ECONOMICS_API_KEY` |
| Macro News | Trading Economics News API (`/news`) | opt-in `TE_NEWS_ENABLED=1` (plan must include news) |
| Breaking News | adapter slot only — no licensed newswire configured | **NOT CONFIGURED** |

## Setup (Windows)

```bat
cd C:\Users\twaha\TRADING\tluxe-trading\bridge\news
copy .env.example .env
```

Edit `bridge\news\.env` (gitignored — never commit it): `TRADING_ECONOMICS_API_KEY=` your Trading Economics
`client:secret`, `TLUXE_NEWS_TOKEN=` a new random secret (`py -c "import secrets; print(secrets.token_urlsafe(32))"`).
Start: `bridge\news\start_news.cmd`. Then TLUXE (http://localhost:5182) → **Settings → News Providers**: enable, URL
`http://127.0.0.1:8768`, paste the **backend token** (never the Trading Economics key) → Save.

## Normalization (Trading Economics documented fields)

`CalendarId, Date, Country, Category, Event, Reference, ReferenceDate, Source, SourceURL, Actual, Previous, Forecast,
TEForecast, URL, DateSpan, Importance, LastUpdate, Revised, Currency, Unit, Ticker, Symbol` →
`id` (`tradingeconomics:{CalendarId}` = dedup key), event, category, country, currency, `scheduledAt` (UTC ms — TE
times are UTC), importance (`1/2/3 → LOW/MEDIUM/HIGH`, raw kept), actual / forecast / previous / revised / teForecast
(text exactly as supplied; absent or empty → `null`, never 0, never copied from forecast), unit, source, sourceUrl,
TE page url, `providerUpdatedAt` (LastUpdate), `releaseStatus` (RELEASED only when Actual is present), receivedAt,
`raw` (provider record). Repeated identical updates are counted as duplicates; a changed update (e.g. Actual
published, Revised set) is a **revision of the same event** (history kept), never a second event.

## Refresh / streaming (bounded — never aggressive)

- Streaming (`TE_STREAMING=auto`): `wss://stream.tradingeconomics.com`, subscribe `calendar`. Entitlement is
  **detected**: a 401 / 403 handshake or an auth / subscription error → `NOT_ENTITLED` (re-checked after 6 h, no
  loop) and REST keeps working. Calendar status is **LIVE** only while streaming is connected and messages arrive.
- REST: calendar window every 15 min; `/calendar/updates` every 5 min, every 60 s only while a MEDIUM/HIGH release is
  within −15 / +10 min (and streaming is not delivering). Status **DELAYED** (delay = refresh interval).
- **STALE** when no successful refresh within 3 × interval; **ERROR** with the reason on auth / entitlement (30 min
  hold-off), rate limit (doubling back-off) or network problems.

## API

`GET /v1/health` · `GET /v1/calendar?since=SEQ` · `GET /v1/headlines?feed=macro|breaking&since=SEQ` — Bearer token,
exact origin allowlist (5182 / 5181 / 4181, never `*`), 127.0.0.1 only, read-only, secrets redacted everywhere.

Ports: MT5 8765 · Databento 8766 · TLUXE AI 8767 · **News 8768** · Vite 5182.

## Tests

`.venv\Scripts\python -m unittest discover -s tests` (TEST DATA shaped like the documented payloads; local websocket
server for streaming; no network).
