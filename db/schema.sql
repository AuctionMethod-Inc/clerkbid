-- ClerkBid / ClerkPad — required before registration works.
--
-- Neon (Vercel Storage): Dashboard → your project → SQL Editor → paste this file → Run.
-- CLI: psql "$DATABASE_URL" -f db/schema.sql   (use pooled or direct URL from Neon)
--
-- If `users` already exists with a legacy `name` column (no first_name), run
-- db/migrate_users_first_last.sql once in Neon before deploying the latest app.

CREATE TABLE IF NOT EXISTS vendors (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(120) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255) NOT NULL,
  vendor_id INTEGER NOT NULL REFERENCES vendors (id) ON DELETE CASCADE,
  org_role VARCHAR(20) NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_org_role_check CHECK (org_role IN ('admin', 'clerk', 'cashier'))
);

CREATE INDEX IF NOT EXISTS idx_users_vendor_id ON users (vendor_id);

CREATE TABLE IF NOT EXISTS vendor_invites (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors (id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  org_role VARCHAR(20) NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_by_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ,
  CONSTRAINT vendor_invites_org_role_check CHECK (org_role IN ('admin', 'clerk', 'cashier')),
  CONSTRAINT vendor_invites_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_vendor_invites_vendor_id ON vendor_invites (vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_invites_email_lower ON vendor_invites (lower(email));

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_token_hash ON password_reset_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_user_id ON password_reset_tokens (user_id);

CREATE TABLE IF NOT EXISTS event_cloud_snapshots (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors (id) ON DELETE CASCADE,
  event_sync_id UUID NOT NULL,
  last_push_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 2,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vendor_id, event_sync_id)
);

CREATE INDEX IF NOT EXISTS idx_event_cloud_snapshots_vendor_id ON event_cloud_snapshots (vendor_id);

CREATE TABLE IF NOT EXISTS vendor_directory_snapshots (
  vendor_id INTEGER PRIMARY KEY REFERENCES vendors (id) ON DELETE CASCADE,
  last_push_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_sync_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  monthly_backup_email BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_sync_ops (
  id BIGSERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors (id) ON DELETE CASCADE,
  event_sync_id UUID NOT NULL,
  op_id UUID NOT NULL,
  actor_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  op_type VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  client_created_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT event_sync_ops_op_id_unique UNIQUE (op_id)
);

CREATE INDEX IF NOT EXISTS idx_event_sync_ops_vendor_event_id
  ON event_sync_ops (vendor_id, event_sync_id, id);

CREATE TABLE IF NOT EXISTS global_announcements (
  id UUID PRIMARY KEY,
  title TEXT,
  body TEXT NOT NULL,
  severity VARCHAR(16) NOT NULL CHECK (severity IN ('info', 'warning')),
  issued_at TIMESTAMPTZ NOT NULL,
  delivery_audience VARCHAR(32) NOT NULL
    CHECK (delivery_audience IN ('online_now', 'persist_cross_session')),
  visible_in_message_center BOOLEAN NOT NULL DEFAULT true,
  created_by_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_global_announcements_issued_at
  ON global_announcements (issued_at DESC);

CREATE TABLE IF NOT EXISTS user_announcement_toasts_shown (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  announcement_id UUID NOT NULL REFERENCES global_announcements (id) ON DELETE CASCADE,
  shown_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, announcement_id)
);

CREATE INDEX IF NOT EXISTS idx_user_announcement_toasts_user
  ON user_announcement_toasts_shown (user_id);
