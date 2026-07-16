-- ====================================================================
-- Nexus Gate - 0017_account_deactivation_email_verify.sql
-- --------------------------------------------------------------------
-- Adds columns for:
--   1. Email verification tracking (email_verified_at) - set when the
--      user clicks the Supabase confirmation link and the callback
--      activates the account.
--   2. Account deactivation (soft delete) - is_deactivated, deactivated_at,
--      deactivated_reason. Never hard-delete user data; flag instead so
--      attendance records, audit logs, and event ownership are preserved.
--
-- All columns use IF NOT EXISTS so the migration is idempotent and safe
-- to re-run. Existing rows get sensible defaults (not deactivated,
-- email not verified).
--
-- Index on is_deactivated for the admin accounts list query that filters
-- out deactivated accounts by default.
-- ====================================================================

-- Email verification timestamp (nullable: null = not yet verified).
ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Soft-delete / deactivation fields.
ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS is_deactivated BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS deactivated_reason TEXT;

-- Backfill: ensure all existing rows have is_deactivated = FALSE
-- (required because the column is NOT NULL).
UPDATE accounts SET is_deactivated = FALSE WHERE is_deactivated IS NULL;

-- Index for the accounts list query: WHERE is_deactivated = FALSE.
CREATE INDEX IF NOT EXISTS idx_accounts_is_deactivated
    ON accounts (is_deactivated);

-- End of migration 0017_account_deactivation_email_verify.sql
