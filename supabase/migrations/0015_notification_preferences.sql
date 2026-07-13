-- ====================================================================
-- Nexus Gate — 0015_notification_preferences.sql
-- --------------------------------------------------------------------
-- Adds a notification_prefs JSONB column to accounts. Stores per-user
-- notification preferences (which types of notifications they want to
-- receive via email/push). The app layer reads/writes this as a JSON
-- object like: {"eventReminders": true, "attendanceSummary": false,
-- "accountSecurity": true}.
--
-- Default: all notification types enabled (backward compatible).
-- ====================================================================

ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS notification_prefs JSONB
    DEFAULT '{"eventReminders": true, "attendanceSummary": true, "accountSecurity": true}'::jsonb;

-- Backfill existing rows with the default.
UPDATE accounts
SET notification_prefs = '{"eventReminders": true, "attendanceSummary": true, "accountSecurity": true}'::jsonb
WHERE notification_prefs IS NULL;

-- End of migration 0015_notification_preferences.sql
