-- ====================================================================
-- Migration 0011: Scalability indexes + passkey credential ID + pg_trgm
-- --------------------------------------------------------------------
-- Targets the capacity assessment findings for 150-200 concurrent /
-- 3000-3500 max users (CTU Danao departmental-wide).
--
-- 1. pg_trgm extension + GIN indexes for LIKE '%query%' searches
--    (7 routes do substring searches that currently force seq scans)
-- 2. Composite index on events(ownerId, status, scheduledAt) for
--    organizer dashboard
-- 3. accounts.createdAt index for admin roster sort
-- 4. passkey_credential_id column + unique index — enables O(log N)
--    lookup instead of O(N) scan + N crypto ops in passkey login
-- 5. Purge helpers: event_attendance + audit_logs retention functions
-- ====================================================================

-- 1. pg_trgm for fast substring search (LIKE '%query%')
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_accounts_fullname_trgm
  ON accounts USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_accounts_email_trgm
  ON accounts USING gin (email gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_events_title_trgm
  ON events USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_authorized_students_fullname_trgm
  ON authorized_students USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_authorized_students_email_trgm
  ON authorized_students USING gin (email gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action_trgm
  ON audit_logs USING gin (action gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_notifications_body_trgm
  ON notifications USING gin (body gin_trgm_ops);

-- 2. Composite index for organizer dashboard (ownerId + status + scheduledAt)
CREATE INDEX IF NOT EXISTS idx_events_owner_status_scheduled
  ON events (owner_id, status, scheduled_at);

-- 3. Admin roster sorts by createdAt DESC
CREATE INDEX IF NOT EXISTS idx_accounts_created_at
  ON accounts (created_at);

-- 4. passkey_credential_id — extracted from the credential JSON for O(log N) lookup
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS passkey_credential_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_passkey_credential_id
  ON accounts (passkey_credential_id)
  WHERE passkey_credential_id IS NOT NULL;

-- 5. Purge functions (called by /api/cron/cleanup)
-- event_attendance: keep 180 days, delete older
CREATE OR REPLACE FUNCTION purge_old_event_attendance(days_to_keep INT DEFAULT 180)
RETURNS BIGINT AS $$
DECLARE
  deleted_count BIGINT;
BEGIN
  DELETE FROM event_attendance
  WHERE scanned_at < NOW() - (days_to_keep || ' days')::INTERVAL;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- audit_logs: keep 90 days, delete older
CREATE OR REPLACE FUNCTION purge_old_audit_logs(days_to_keep INT DEFAULT 90)
RETURNS BIGINT AS $$
DECLARE
  deleted_count BIGINT;
BEGIN
  DELETE FROM audit_logs
  WHERE created_at < NOW() - (days_to_keep || ' days')::INTERVAL;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
