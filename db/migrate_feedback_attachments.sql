-- Feedback screenshots: Vercel Blob URLs attached to a submission (issue #50).
--
-- Run once in Neon (Dashboard → SQL Editor) or:
--   psql "$DATABASE_URL" -f db/migrate_feedback_attachments.sql
--
-- Until this column exists, submissions still save; the screenshot links are
-- only missing from the row (they still appear in the GitHub issue and Slack).
-- The reconcile cron reads this column, so run it before deploying.

ALTER TABLE feedback_submissions
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
