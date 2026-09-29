-- IBKR COMEX price-level depth observations, recorded server-side by the gateway (independent of any browser).
-- One row per recorded event:
--   snapshot  the full visible book (every level: price, displayed size, IBKR position) - on (re)sync and every 60 s
--   delta     every level change observed in consecutive IBKR snapshots during ~1 s: [ts_ms, side, price, size, pos, op]
--             (side 0 = bid, 1 = ask; op 0 = delete, 1 = insert, 2 = update); also extends liveness (t1_ms)
--   gap       the book stopped being trustworthy at t0_ms (stale / offline / reconnecting / contract change / error)
-- Times are the IBKR bridge receive time (the depth service's lastUpdate, UTC ms) - not exchange timestamps.
-- Nothing is ever inferred: the heatmap only draws time covered by recorded rows.
CREATE TABLE ibkr_depth_obs (
  id          BIGSERIAL PRIMARY KEY,
  root        TEXT NOT NULL CHECK (root IN ('GC', 'SI')),
  contract    TEXT NOT NULL,
  provider    TEXT NOT NULL DEFAULT 'IBKR',
  kind        TEXT NOT NULL CHECK (kind IN ('snapshot', 'delta', 'gap')),
  t0_ms       BIGINT NOT NULL,
  t1_ms       BIGINT NOT NULL,
  epoch       INTEGER,
  seq_from    BIGINT,
  seq_to      BIGINT,
  n_obs       INTEGER NOT NULL DEFAULT 0,
  data        TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ibkr_depth_obs_root_t0 ON ibkr_depth_obs (root, contract, t0_ms, id);
CREATE INDEX ibkr_depth_obs_snap ON ibkr_depth_obs (root, contract, t0_ms) WHERE kind = 'snapshot';
