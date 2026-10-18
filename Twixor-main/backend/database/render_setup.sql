-- =====================================================================
-- TWIXOR — one-time Supabase setup for the Render deployment
-- Supabase Dashboard -> SQL Editor -> New query -> paste -> Run
-- (Safe to run more than once.)
-- =====================================================================

-- 1) Persistent settings store (admin settings survive Render restarts)
CREATE TABLE IF NOT EXISTS app_kv (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE app_kv ENABLE ROW LEVEL SECURITY;   -- only the server's service-role key can access it

-- 2) Column the code already uses
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS telegram TEXT;

-- 3) Indexes that make login + admin panel fast
CREATE INDEX IF NOT EXISTS idx_users_handle_lower ON users (lower(handle));
CREATE INDEX IF NOT EXISTS idx_users_email_lower  ON users (lower(email));
CREATE INDEX IF NOT EXISTS idx_users_created      ON users (created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_created     ON credits_ledger (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_action      ON credits_ledger (action);
CREATE INDEX IF NOT EXISTS idx_requests_status    ON access_requests (status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_engaged_tweet_user ON engaged_tweets (user_id, tweet_id);
