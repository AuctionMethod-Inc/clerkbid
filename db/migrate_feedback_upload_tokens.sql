-- Feedback screenshots: one row per upload permission handed out (issue #50).
--
-- The upload route counts these under a per-user advisory lock, so the daily
-- cap holds even when someone requests many permissions before uploading.
--
-- Run once in Neon (Dashboard → SQL Editor) or:
--   psql "$DATABASE_URL" -f db/migrate_feedback_upload_tokens.sql
--
-- Screenshot uploads fail until this table exists. Run it before deploying.

CREATE TABLE IF NOT EXISTS feedback_upload_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_upload_tokens_user_time
  ON feedback_upload_tokens (user_id, issued_at);
