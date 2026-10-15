-- Feedback loop: persist every /feedback submission so it can be mirrored to a
-- GitHub issue and a Slack thread, and so rate limits can be enforced.
--
-- Run once in Neon (Dashboard → SQL Editor) or:
--   psql "$DATABASE_URL" -f db/migrate_feedback_submissions.sql
--
-- Until this table exists the /api/feedback route still emails info@ and
-- returns success; it just logs that persistence is unavailable.

CREATE TABLE IF NOT EXISTS feedback_submissions (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source VARCHAR(16) NOT NULL CHECK (source IN ('form', 'app')),
  kind VARCHAR(16) NOT NULL DEFAULT 'other'
    CHECK (kind IN ('bug', 'feature', 'question', 'other')),
  name VARCHAR(120),
  email VARCHAR(254) NOT NULL,
  message TEXT NOT NULL,
  steps TEXT,
  user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  vendor_id INTEGER REFERENCES vendors (id) ON DELETE SET NULL,
  org_role VARCHAR(20),
  event_sync_id UUID,
  page_path TEXT,
  app_version VARCHAR(32),
  user_agent TEXT,
  ip_hash VARCHAR(64),
  trust VARCHAR(16) NOT NULL DEFAULT 'anonymous' CHECK (trust IN ('user', 'anonymous')),
  github_issue_number INTEGER,
  slack_channel_id VARCHAR(32),
  slack_ts VARCHAR(32),
  status VARCHAR(24) NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'triaged', 'in_progress', 'waiting_on_human', 'shipped', 'closed', 'spam')),
  email_sent BOOLEAN NOT NULL DEFAULT false,
  issue_error TEXT,
  slack_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_feedback_submissions_created_at ON feedback_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_submissions_issue ON feedback_submissions (github_issue_number);
CREATE INDEX IF NOT EXISTS idx_feedback_submissions_ip_hash_created ON feedback_submissions (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_submissions_email_created ON feedback_submissions (lower(email), created_at);
