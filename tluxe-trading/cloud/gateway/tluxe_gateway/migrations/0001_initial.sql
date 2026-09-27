-- Trading by TLUXE - initial schema. Durable application data only: NO market ticks, NO provider secrets.
-- High-frequency market data stays in the providers / memory; everything here has a retention policy (see
-- retention.sql and docs/CLOUD_DEPLOYMENT.md).

CREATE TABLE app_config (
  key         TEXT PRIMARY KEY CHECK (key ~ '^[a-z0-9_.-]{1,80}$'),
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- configuration only: credentials belong in the platform's secret variables, never in this table
  CONSTRAINT app_config_no_secret_keys CHECK (key !~* '(secret|token|password|api[_-]?key|credential)')
);

CREATE TABLE instrument_mappings (
  instrument_id    TEXT NOT NULL,
  provider         TEXT NOT NULL,
  role             TEXT NOT NULL,            -- price | depth | trades | ...
  provider_symbol  TEXT NOT NULL,
  inverted         BOOLEAN NOT NULL DEFAULT false,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, provider, role)
);

-- Service / provider status transitions (written only on change; bounded by retention).
CREATE TABLE status_events (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('service', 'provider')),
  component    TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('LIVE', 'DELAYED', 'STALE', 'NOT CONNECTED', 'UNAVAILABLE', 'ERROR')),
  detail       TEXT,
  market_open  BOOLEAN,
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX status_events_component_time ON status_events (component, observed_at DESC);

-- Normalized economic-calendar events (one row per provider event; revisions update the SAME row).
CREATE TABLE news_calendar_events (
  dedup_key            TEXT PRIMARY KEY,
  provider             TEXT NOT NULL,
  provider_event_id    TEXT NOT NULL,
  event                TEXT NOT NULL,
  category             TEXT,
  country              TEXT,
  currency             TEXT,
  importance           TEXT CHECK (importance IN ('LOW', 'MEDIUM', 'HIGH')),
  importance_raw       INTEGER,
  scheduled_at         TIMESTAMPTZ NOT NULL,
  actual               TEXT,          -- NULL until the provider publishes it (never 0, never the forecast)
  forecast             TEXT,
  previous             TEXT,
  revised              TEXT,
  unit                 TEXT,
  source               TEXT,
  source_url           TEXT,
  provider_updated_at  TIMESTAMPTZ,
  release_status       TEXT NOT NULL CHECK (release_status IN ('SCHEDULED', 'RELEASED')),
  first_received_at    TIMESTAMPTZ NOT NULL,
  last_changed_at      TIMESTAMPTZ NOT NULL,
  revision             INTEGER NOT NULL DEFAULT 0,
  raw                  JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX news_calendar_events_time ON news_calendar_events (scheduled_at);

CREATE TABLE news_event_revisions (
  dedup_key   TEXT NOT NULL REFERENCES news_calendar_events (dedup_key) ON DELETE CASCADE,
  revision    INTEGER NOT NULL,
  changes     JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (dedup_key, revision)
);

CREATE TABLE news_headlines (
  dedup_key          TEXT PRIMARY KEY,
  provider           TEXT NOT NULL,
  feed               TEXT NOT NULL CHECK (feed IN ('macro', 'breaking')),
  headline           TEXT NOT NULL,
  source             TEXT,
  source_url         TEXT,
  category           TEXT,
  country            TEXT,
  importance         TEXT CHECK (importance IN ('LOW', 'MEDIUM', 'HIGH')),
  provider_sentiment TEXT,             -- only when the provider genuinely supplies it
  published_at       TIMESTAMPTZ NOT NULL,
  received_at        TIMESTAMPTZ NOT NULL
);
CREATE INDEX news_headlines_time ON news_headlines (published_at DESC);

CREATE TABLE alerts (
  id           BIGSERIAL PRIMARY KEY,
  alert_key    TEXT NOT NULL UNIQUE,   -- provider:event:type style dedupe key
  source       TEXT NOT NULL,          -- news | hle | smc | ...
  type         TEXT NOT NULL,
  title        TEXT NOT NULL,
  message      TEXT,
  event_key    TEXT,
  instrument_id TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL,
  raised_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ
);
CREATE INDEX alerts_time ON alerts (raised_at DESC);

-- Engine snapshots: bounded per (engine, instrument, timeframe) by retention; payload size-capped by the API.
CREATE TABLE engine_snapshots (
  id             BIGSERIAL PRIMARY KEY,
  engine         TEXT NOT NULL,
  instrument_id  TEXT NOT NULL,
  timeframe      TEXT NOT NULL DEFAULT '',
  knowledge_time TIMESTAMPTZ,
  computed_at    TIMESTAMPTZ NOT NULL,
  payload        JSONB NOT NULL,
  UNIQUE (engine, instrument_id, timeframe, computed_at)
);
CREATE INDEX engine_snapshots_lookup ON engine_snapshots (engine, instrument_id, timeframe, computed_at DESC);

-- AI conversation METADATA only (no message content unless deliberately enabled later).
CREATE TABLE ai_conversations (
  id             UUID PRIMARY KEY,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity  TIMESTAMPTZ NOT NULL DEFAULT now(),
  message_count  INTEGER NOT NULL DEFAULT 0,
  model          TEXT,
  instrument_id  TEXT
);

CREATE TABLE data_integrity_events (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL,          -- databento | mt5 | news | ...
  instrument_id TEXT,
  kind          TEXT NOT NULL,          -- GAP | SEQUENCE | STALE | ROLL | DUPLICATE | REJECTED | ...
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX data_integrity_events_time ON data_integrity_events (observed_at DESC);

-- Owner sessions: only the SHA-256 of the session id is stored; rotation revokes the previous one.
CREATE TABLE sessions (
  id_sha256    TEXT PRIMARY KEY CHECK (id_sha256 ~ '^[0-9a-f]{64}$'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX sessions_expiry ON sessions (expires_at);

CREATE TABLE auth_events (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('LOGIN_OK', 'LOGIN_FAIL', 'LOGOUT', 'ROTATE', 'BRIDGE_OK', 'BRIDGE_REJECTED')),
  detail      TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
