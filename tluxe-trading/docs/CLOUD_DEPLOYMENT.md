# Trading by TLUXE — cloud deployment (Railway + Windows VPS)

Status: **the repository is cloud-ready; nothing has been deployed.** Production deployment, DNS and every purchase
are the owner's decision. The local development setup (Vite on 5182, bridges on 8765–8768) is unchanged.

Goal: the app keeps working while the home PC is off. The home PC is not part of the production chain.

## 1. Architecture

```
 Phone / any computer (browser)
        │  HTTPS + WSS  (one origin: PUBLIC_APP_URL)
        ▼
 ┌─────────────────────────── Railway project ───────────────────────────┐
 │  tluxe-web  (PUBLIC domain)      Dockerfile (tluxe-trading/)          │
 │   • serves the cloud web bundle (built with --mode cloud)             │
 │   • owner sign-in → HttpOnly session cookie · strict CORS · CSP/HSTS  │
 │   • /api/*  read-only API gateway  ·  /api/stream  WSS (seq, heartbeat)│
 │   • /bridge/mt5  WSS endpoint for the Windows VPS link (token hash)   │
 │   • unified health · PostgreSQL migrations + retention                │
 │        │ private network (*.railway.internal, never public)           │
 │        ├──► tluxe-ai         bridge/ai/Dockerfile        :8767        │
 │        ├──► tluxe-databento  bridge/databento/Dockerfile :8766        │
 │        ├──► tluxe-news       bridge/news/Dockerfile      :8768        │
 │        └──► Postgres         (Railway PostgreSQL plugin)              │
 └───────────────────────────────▲───────────────────────────────────────┘
                                 │ OUTBOUND WSS only (no inbound port on the VPS)
 ┌───────────────────────────────┴──── Windows Cloud VPS ────────────────┐
 │  MetaTrader 5 terminal  ◄──  TLUXE MT5 bridge (127.0.0.1:8765, as today)│
 │                              ▲                                         │
 │                  bridge/mt5/remote_link  (read-only relay, outbound)   │
 └────────────────────────────────────────────────────────────────────────┘
```

* Only **tluxe-web** gets a public domain. AI, Databento, news and PostgreSQL are reachable only on Railway's
  private network. The VPS accepts no inbound connection: the link dials out to the gateway.
* Linux Railway cannot run the MT5 terminal. MT5 stays on Windows. The existing local MT5 bridge is unchanged and
  still runs on the home PC for development.
* Redis is not used. One gateway replica holds the stream hub and the MT5 link. Durable state (status history,
  sessions, alerts, calendar revisions) lives in PostgreSQL.

## 2. Services and files

| Railway service | Dockerfile | Config as code | Port | Public |
|---|---|---|---|---|
| tluxe-web (gateway + web app) | `Dockerfile` at `tluxe-trading/`, picked up automatically (multi-stage: Node builds `build:cloud`, Python serves) | `cloud/railway/web.railway.json` | `$PORT` | **yes** |
| tluxe-ai | `bridge/ai/Dockerfile` | `cloud/railway/ai.railway.json` | 8767 | no |
| tluxe-databento | `bridge/databento/Dockerfile` | `cloud/railway/databento.railway.json` | 8766 | no |
| tluxe-news | `bridge/news/Dockerfile` | `cloud/railway/news.railway.json` | 8768 | no |
| Postgres | Railway PostgreSQL | — | — | no |

Every image:
* runs as non-root (uid 10001)
* has a `/healthz` liveness HEALTHCHECK and stops gracefully on `STOPSIGNAL SIGTERM`
* logs JSON with secrets redacted
* bakes in no secrets
* uses build context `tluxe-trading/`, and `.dockerignore` keeps `.env` files, venvs, tests and `node_modules` out

Every Railway config sets `restartPolicyType: ON_FAILURE` (10 retries), `healthcheckPath: /healthz` and
`numReplicas: 1`. **Keep tluxe-web at one replica**: the stream hub, the MT5 link and the login limiter are
per-process.

## 3. Environment variables (names only — values go in Railway Variables, never in Git)

**tluxe-web (gateway)** — see `cloud/gateway/.env.example`
* Optional — IBKR depth (see §5b): `TLUXE_IBKR_DEPTH_URL` + `TLUXE_IBKR_DEPTH_TOKEN` (server-side pull, preferred), or
  the older inbound link `TLUXE_IBKR_BRIDGE_TOKEN_SHA256` (only a hash, never the token).
* Required:
  * `TLUXE_ENV=production`
  * `PUBLIC_APP_URL` and `API_PUBLIC_URL` — the same https origin
  * `ALLOWED_ORIGINS` — exact https origins only; no `*` and no localhost
  * `DATABASE_URL` — `${{Postgres.DATABASE_URL}}`
  * `TLUXE_OWNER_PASSWORD_HASH` — a salted hash, never the password. Generate it offline, either:
    * open `tools/owner-password-hash.html` from a local copy of the repository in any current browser (WebCrypto,
      PBKDF2-HMAC-SHA256, 600,000 iterations; the page has a `default-src 'none'` CSP, so it cannot send anything), or
    * `python -m tluxe_gateway.hashpw` (scrypt; falls back to PBKDF2 when Python lacks `hashlib.scrypt`).
  * While this variable is **absent**, the gateway runs in public read-only market-data mode (Databento / MT5 GETs
    only). As soon as it is set, that mode is OFF: every `/api/*` route except `/api/config` and `/api/auth/login`
    needs the owner session, and the web app shows the TLUXE sign-in page. Removing the variable returns to public
    read-only mode (the recovery path if the owner password is ever lost - then generate a new hash).
* Internal services:
  * `TLUXE_AI_URL`, `TLUXE_AI_TOKEN`
  * `TLUXE_DATABENTO_URL`, `TLUXE_DB_BRIDGE_TOKEN`
  * `TLUXE_NEWS_URL`, `TLUXE_NEWS_TOKEN`
* MT5 link: `TLUXE_MT5_BRIDGE_TOKEN_SHA256` (comma list for rotation; optional `@expiry`)
* Optional: `TLUXE_SESSION_TTL_HOURS`, `LOG_FORMAT`, `LOG_LEVEL`
* Railway sets `PORT`, which always wins in production. The gateway listens on `0.0.0.0:$PORT`.
* `PUBLIC_APP_URL` defaults to `https://$RAILWAY_PUBLIC_DOMAIN`, and a domain without `https://` is accepted.
* A start-up configuration error names **every** missing variable in one log line and exits with code 2. Authentication is never optional in production.
* A bad optional upstream URL shows as ERROR in `/api/status`; it never crashes the gateway.
* The gateway retries the database for about 2 minutes while PostgreSQL is still starting.

**Databento on the gateway (recommended, no extra service)**
* Set `DATABENTO_API_KEY` on tluxe-web / tluxe-auth-gateway.
* `cloud/gateway/entrypoint.py` then runs the Databento bridge next to the gateway in the same container. The bridge
  uses the official SDK on `GLBX.MDP3`, and GC resolves through `GC.v.0` to the active contract.
* The key goes to the bridge process only; the gateway process never receives it.
* The gateway ↔ bridge token is random at each boot.
* `GET /api/databento/status?root=GC` (signed in) reports:
  * connection, dataset and plan
  * the active contract and instrument ID
  * the last event time (UTC), its age and freshness
  * the last real trade and the last OHLCV bar
  * `verifiedByRealData`, which is true only after real records have arrived
* Without the key, Databento shows NOT CONNECTED and GC shows DATA UNAVAILABLE.

**tluxe-ai**
* `OPENAI_API_KEY`, `TLUXE_AI_TOKEN`
* Optional: `TLUXE_AI_MODEL`, `TLUXE_AI_TIMEOUT_S`, `TLUXE_AI_MAX_OUTPUT_TOKENS`

**tluxe-databento**
* `DATABENTO_API_KEY`, `TLUXE_DB_BRIDGE_TOKEN`
* The image fixes `TLUXE_DB_PLAN=standard` and `TLUXE_DB_DATASET=GLBX.MDP3`.
* Optional: `TLUXE_DB_CONTRACT_MODE`, `TLUXE_DB_CONTRACT_GC`, `TLUXE_DB_CONTRACT_SI`, `TLUXE_DB_REPLAY_HOURS`
* CME Globex MDP 3.0 Standard gives trades and OHLCV only. MBO and MBP-10 are not entitled, so depth reports
  UNSUPPORTED.

**tluxe-news**
* `TLUXE_NEWS_TOKEN`
* `TRADING_ECONOMICS_API_KEY` — when it is absent, the news service reports NOT CONNECTED.
* Optional: the `TE_*` switches in `bridge/news/.env.example`

**Windows VPS link** (`bridge/mt5/remote_link/.env`)
* `TLUXE_GATEWAY_BRIDGE_URL` — `wss://<domain>/bridge/mt5`
* `TLUXE_MT5_BRIDGE_TOKEN` — at least 32 random characters, and different from the local token
* `TLUXE_BRIDGE_ID`
* Optional: `TLUXE_LOCAL_BRIDGE_URL`
* The local `TLUXE_BRIDGE_TOKEN` is read from `bridge/mt5/.env`.

Tokens shared between two services, such as `TLUXE_AI_TOKEN`, must be the same random value on both sides. Generate
them with `python -c "import secrets; print(secrets.token_urlsafe(48))"`.

## 4. Database

`DATABASE_URL` only. The gateway applies `cloud/gateway/tluxe_gateway/migrations/*.sql` at start-up:
* It holds an advisory lock while migrating.
* `schema_migrations` records a checksum for each migration, and start-up refuses to run if an applied migration
  was edited.

| Table | Contents |
|---|---|
| `app_config` | Non-secret settings (a CHECK constraint rejects secret-like keys) |
| `instrument_mappings` | Instrument mappings |
| `status_events` | Health transitions: LIVE / DELAYED / STALE / NOT CONNECTED / UNAVAILABLE / ERROR |
| `news_calendar_events`, `news_event_revisions` | Calendar events with their revision history |
| `news_headlines` | Headlines |
| `alerts` | Alerts, deduplicated by key |
| `engine_snapshots` | Engine snapshots, ≤ 64 KB each |
| `ai_conversations` | Metadata only |
| `data_integrity_events` | Data-integrity events |
| `sessions` | SHA-256 of the session id only |
| `auth_events` | Sign-in and bridge-authentication events |

No ticks, order books or candles are stored; market data stays with the providers.

Retention runs daily (`migrations/retention.sql`):

| Data | Kept for |
|---|---|
| Status events | 30 days |
| Integrity events | 90 days |
| Headlines | 90 days |
| Calendar | 400 days |
| Alerts | 180 days |
| Auth events | 180 days |
| AI metadata | 180 days |
| Snapshots | 30 days, at most 200 per key |
| Expired sessions | 7 days after expiry |

## 5. MT5 remote bridge (Windows VPS)

The link runs `bridge/mt5/remote_link/` next to the unchanged local bridge.

**Connection**
* Outbound **WSS** to `/bridge/mt5`. Plain `ws://` is accepted only for loopback tests.
* `Authorization: Bearer <TLUXE_MT5_BRIDGE_TOKEN>`. The gateway stores only the SHA-256, compares in constant
  time, supports expiry and records failed attempts.

**Token rotation**
1. Add the new hash next to the old one in `TLUXE_MT5_BRIDGE_TOKEN_SHA256`.
2. Switch the VPS `.env` to the new token and restart the link.
3. Remove the old hash.

**Message integrity**
* Every message carries `seq` (strictly increasing) and `ts`.
* Replays and out-of-order messages are rejected.
* Timestamps more than ±30 s from the gateway clock are rejected.
* Gaps are counted.

**Liveness and reconnect**
* Heartbeat every 10 s, carrying the terminal health.
* If nothing arrives for 30 s, the gateway marks the link stale and closes it. The link does the same after 45 s.
* The link reconnects with back-off from 2 s up to 60 s, with jitter. After an authentication rejection it waits
  300 s, so there is no tight loop.

**Read-only**
* GET only.
* Only health, symbols, symbol, quote and rates paths are allowed. Anything else returns 403 before it reaches MT5.
* The gateway exposes no POST, PUT or DELETE and no order route. `/api/orders` returns 404.

**Freshness**
* MT5 feed is LIVE only with a quote fresher than 60 s while the market is open.
* Outside market hours it shows STALE with `expected: true`, displayed as MARKET CLOSED. Market hours are
  Sun 18:00 ET to Fri 17:00 ET, with a daily break from 17:00 to 18:00 ET.

## 5b. IBKR COMEX Level-2 depth bridge (cloud Windows VPS)

Runbook: `bridge/ibkr/README.md`. IBKR is the **depth source only** (Databento keeps trades / history / volume).
* VPS: IB Gateway (logged in by the owner; Read-Only API; auto-restart daily) → `bridge/ibkr` → outbound **WSS** to
  `/bridge/ibkr` with `Authorization: Bearer <TLUXE_IBKR_BRIDGE_TOKEN>` (VPS `.env` only).
* Railway variable: `TLUXE_IBKR_BRIDGE_TOKEN_SHA256` (sha256 of that token; `hash@expiry` and comma lists for rotation).
  Only when it is set does `/api/config` report `ibkrDepth: true` and the web app register the IBKR depth provider.
* Browsers read `/api/ibkr/status | book | updates` (same origin; public read-only while owner login is not configured,
  session-protected once it is). No browser request ever goes to localhost, the VPS or a home PC.
* Target contracts = the ACTIVE Databento contract per root; a mismatching IBKR book is withheld (CONTRACT_MISMATCH).
* **Pull mode (current production path):** `TLUXE_IBKR_DEPTH_URL=https://depth.twahatrading.com` and
  `TLUXE_IBKR_DEPTH_TOKEN` (Railway secret; never in Git, a `VITE_*` variable, a log, an error or an API response).
  The gateway alone calls `GET {url}/depth/GC` and `/depth/SI` with `Authorization: Bearer <token>` (sequential per
  root, every 0.5 s, 3 s timeout, https only), validates every snapshot (symbol = requested root, `depthType`
  `PRICE_LEVEL`, `mbo` false, numeric rows) and serves it through the same `/api/ibkr/*` API. Pull mode takes
  precedence over the inbound link. States: LIVE, STALE (`lastUpdate` > 10 s old or an empty book), RECONNECTING,
  OFFLINE (3 failed polls or HTTP 401/403), NOT ENTITLED, UNSUPPORTED — depth is withheld in every state but LIVE.
  An older `lastUpdate` never overwrites a newer book. `lastUpdate` is the bridge receive time, not an exchange time.
  Depth type: **PRICE_LEVEL** (aggregated levels, ~10 per side) — **not MBO**: no order ids, order counts or queue
  positions. The heatmap draws only depth recorded since the page opened (no earlier depth exists or is backfilled).
* **Recorded depth history (server-side):** the gateway persists every accepted IBKR observation in PostgreSQL
  (`ibkr_depth_obs`: full-book snapshots on sync and every 60 s, level-change batches ~1 s with IBKR timestamps /
  position / op, and gap rows when the book stops being trustworthy). Recording runs in the gateway, not the browser.
  `GET /api/ibkr/heatmap?root=&from=&to=&bucket=` returns the time × price matrix (time-weighted displayed size per
  bucket, only for recorded-valid time; nothing before the first stored snapshot, no carry across gaps / restarts);
  `GET /api/ibkr/history` reports first stored time, rows, observations, table size. Retention:
  `TLUXE_IBKR_DEPTH_RETENTION_DAYS` (default 7). Timestamps are IBKR bridge receive times, not exchange times.
* Home PC required: **no**. Cloud VPS required: **yes**. Permanent unattended IBKR authentication: **not claimed** —
  a manual IB Gateway login can be required after the weekly reset (TLUXE shows IBKR AUTH REQUIRED; depth stops).

## 6. Security controls

**Browser side**
* The browser never holds a provider key or service token. The cloud bundle contains no localhost endpoint and no
  credential: `npm run build:cloud` fails otherwise (`scripts/scan-bundle.cjs`).
* In cloud mode, URLs and tokens stored in `localStorage` from an older local setup are ignored.

**Sign-in and sessions**
* Owner sign-in uses scrypt.
* The session cookie is HttpOnly, `SameSite=Strict` and `Secure`, with a 12 h TTL and hourly rotation.
* Sign-in is rate-limited: after 5 failures the lock lasts 300 s and doubles each time.
* Production POSTs must carry an allowed `Origin`.

**CORS and headers**
* CORS is exact-origin only. Production refuses to start if `*`, localhost or a non-https origin is configured.
* WebSocket upgrades check `Origin` as well as the session.
* Headers: CSP, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, HSTS in production, `Referrer-Policy`.

**Logs and AI**
* Logs are JSON, with a redactor for tokens, Bearer headers, DSN passwords and `sk-` / `db-` keys.
* The AI receives a read-only context from which credential-named fields are dropped. It has no order, shell,
  file or source-code capability.

**Zero fake data**
* A missing provider shows NOT CONNECTED or UNAVAILABLE.
* LIVE always requires freshly observed data. A running process alone is never LIVE.

## 7. Branch strategy

* Work happens on feature branches, e.g. `claude/…`.
* Each feature branch goes through a pull request into `main`. CI (`.github/workflows/tluxe-ci.yml`) runs the
  tests only: no secrets, no deploy, no auto-merge.
* A human merges.
* Railway auto-deploys **only from `main`**. Set this per service in Railway → Settings → Source.

## 8. Railway — manual steps (owner, when approved)

1. Create a Railway project and connect the GitHub repository `twahatrading-crypto/TRADING`.
2. Add **PostgreSQL**.
3. Create four services from the repository. For each one:
   * Root Directory: `tluxe-trading`
   * Config file path: `/tluxe-trading/cloud/railway/<web|ai|databento|news>.railway.json`
   * Branch: `main`
   * Name them exactly `tluxe-web`, `tluxe-ai`, `tluxe-databento` and `tluxe-news`, so the private hostnames match.
4. Set each service's Variables (section 3). Set the gateway's `DATABASE_URL` to `${{Postgres.DATABASE_URL}}`.
5. Networking:
   * Generate a public domain **only for tluxe-web**. Add the custom domain later; DNS is the owner's step.
   * Leave the other services private.
6. Once the domain is known, set `PUBLIC_APP_URL`, `API_PUBLIC_URL` and `ALLOWED_ORIGINS` to it and redeploy tluxe-web.
7. Sign in at the domain → Settings → **Cloud connections**. Every component shows its real state.

Local preview of the cloud bundle (optional, nothing leaves the PC):

```
cd cloud/gateway
python -m tluxe_gateway.hashpw
```

This prints a hash. Put it in `cloud/gateway/.env` as `TLUXE_OWNER_PASSWORD_HASH='<hash>'`, then start the gateway:

```
python -m tluxe_gateway
```

It runs in development mode on 127.0.0.1:8780 with an in-memory store. In a second terminal:

```
npm run dev:cloud
```

This serves the cloud bundle on http://localhost:5182, with `/api` and the stream proxied to that gateway. Do not run
it while the normal `npm run dev` is using 5182.

## 9. Windows VPS requirements (MT5)

**Machine and account**
* Windows Server 2019/2022 or Windows 10/11.
* 2 vCPU, 4 GB RAM and 40 GB SSD are enough for one terminal.
* Keep it always on, ideally in a region near the broker server.
* Enable auto-login for the service user so the MT5 terminal starts after a reboot. MT5 needs an interactive
  session.

**Software**
* The MetaTrader 5 terminal, logged in to the broker (read-only use).
* Python 3.11 (64-bit) with `bridge/mt5/requirements.txt` and `bridge/mt5/remote_link/requirements.txt`.

**Processes**
* The local bridge (`bridge/mt5/start_bridge.cmd`) bound to 127.0.0.1:8765.
* The link (`bridge/mt5/remote_link/start_remote_link.cmd`).
* Start both at logon with Task Scheduler ("At log on", restart on failure).

**Network**
* **No inbound ports**: close RDP to the internet or restrict it by IP, with a strong password or VPN.
* Outbound HTTPS/WSS (443) to the Railway domain only.

**Maintenance**
* Keep Windows Update on, with a maintenance window outside market hours.
* Keep the clock synced (w32time), because timestamps outside ±30 s are rejected.
