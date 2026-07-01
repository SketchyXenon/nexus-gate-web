-- Nexus Gate - 0010_supabase_auth_uid.sql
-- Adds a column linking accounts to Supabase Auth users (auth.users.id).
-- This is the bridge between Supabase Auth (identity) and the accounts
-- table (profile + RBAC). Nullable so existing accounts keep working
-- until they're linked (via migration script or next login).

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS supabase_auth_uid UUID UNIQUE;

-- Index for O(1) lookup: "find the account for this Supabase user".
CREATE INDEX IF NOT EXISTS idx_accounts_supabase_auth_uid
  ON accounts (supabase_auth_uid) WHERE supabase_auth_uid IS NOT NULL;
