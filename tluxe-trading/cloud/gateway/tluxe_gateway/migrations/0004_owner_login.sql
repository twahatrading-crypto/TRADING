-- Owner login hardening (whole-site sign-in).
--  * auth_at:   when the owner actually signed in. Rotation copies it, so the 12 h maximum is absolute.
--  * active_at: the owner's last real activity (sign-in or an explicit activity ping from the web app -
--               background polling never moves it), for the 2 h inactivity timeout.
-- Existing rows (none are expected: owner login was never configured) start at their creation time.
ALTER TABLE sessions ADD COLUMN auth_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN active_at TIMESTAMPTZ;
UPDATE sessions SET auth_at = created_at, active_at = created_at WHERE auth_at IS NULL;
ALTER TABLE sessions ALTER COLUMN auth_at SET DEFAULT now();
ALTER TABLE sessions ALTER COLUMN auth_at SET NOT NULL;
ALTER TABLE sessions ALTER COLUMN active_at SET DEFAULT now();
ALTER TABLE sessions ALTER COLUMN active_at SET NOT NULL;

-- The owner's password hash after a change made in the web app. Exactly one row. Only a scrypt /
-- PBKDF2 hash is ever stored - never a password. env_fingerprint ties the row to the bootstrap hash in
-- TLUXE_OWNER_PASSWORD_HASH: putting a NEW hash in that variable (break-glass reset) makes this row stale,
-- so the variable wins again.
CREATE TABLE owner_credential (
  id              SMALLINT PRIMARY KEY CHECK (id = 1),
  password_hash   TEXT NOT NULL CHECK (password_hash ~ '^(scrypt|pbkdf2_sha256)\$'),
  env_fingerprint TEXT NOT NULL CHECK (env_fingerprint ~ '^[0-9a-f]{64}$'),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE auth_events DROP CONSTRAINT auth_events_kind_check;
ALTER TABLE auth_events ADD CONSTRAINT auth_events_kind_check CHECK (kind IN (
  'LOGIN_OK', 'LOGIN_FAIL', 'LOGOUT', 'ROTATE', 'BRIDGE_OK', 'BRIDGE_REJECTED',
  'HLR_BRIDGE_OK', 'HLR_BRIDGE_REJECTED',
  'PASSWORD_CHANGED', 'PASSWORD_CHANGE_FAIL', 'MONITOR_REJECTED'
));
