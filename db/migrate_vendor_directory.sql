-- Org-wide bidder/consignor directory (one JSON snapshot per vendor).
-- Run once in Neon SQL Editor after users/vendors exist.

CREATE TABLE IF NOT EXISTS vendor_directory_snapshots (
  vendor_id INTEGER PRIMARY KEY REFERENCES vendors (id) ON DELETE CASCADE,
  last_push_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
