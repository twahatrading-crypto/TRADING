-- Retention policy (run by the gateway once a day; idempotent). Keeps storage bounded.
DELETE FROM status_events          WHERE observed_at < now() - interval '30 days';
DELETE FROM data_integrity_events  WHERE observed_at < now() - interval '90 days';
DELETE FROM news_headlines         WHERE published_at < now() - interval '90 days';
DELETE FROM news_calendar_events   WHERE scheduled_at < now() - interval '400 days';
DELETE FROM alerts                 WHERE raised_at < now() - interval '180 days';
DELETE FROM sessions               WHERE expires_at < now() - interval '7 days';
DELETE FROM auth_events            WHERE observed_at < now() - interval '180 days';
DELETE FROM ai_conversations       WHERE last_activity < now() - interval '180 days';
-- engine snapshots: at most 200 per (engine, instrument, timeframe) and never older than 30 days
DELETE FROM engine_snapshots WHERE computed_at < now() - interval '30 days';
DELETE FROM engine_snapshots s USING (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY engine, instrument_id, timeframe ORDER BY computed_at DESC) AS rn
    FROM engine_snapshots) ranked WHERE rn > 200) old
WHERE s.id = old.id;
