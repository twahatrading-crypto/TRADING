ALTER TABLE auth_events
DROP CONSTRAINT auth_events_kind_check;

ALTER TABLE auth_events
ADD CONSTRAINT auth_events_kind_check
CHECK (kind IN (
  'LOGIN_OK',
  'LOGIN_FAIL',
  'LOGOUT',
  'ROTATE',
  'BRIDGE_OK',
  'BRIDGE_REJECTED',
  'HLR_BRIDGE_OK',
  'HLR_BRIDGE_REJECTED'
));