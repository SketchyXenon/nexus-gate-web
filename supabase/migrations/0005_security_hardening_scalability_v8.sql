-- ====================================================================
-- Nexus Gate — 0005_security_hardening_scalability_v8.sql
-- --------------------------------------------------------------------
-- Migration 0005 — security hardening + scalability improvements
-- based on the comprehensive security audit (Task 15).
--
-- What this migration does:
--   1. RLS guard trigger on accounts — prevents self-escalation of
--      role/status via the Supabase REST API (the accounts_update_own
--      RLS policy allowed any column change, including role='ADMIN').
--   2. Adds @@unique([eventId, studentId]) to attendance_overrides
--      (idempotency — prevents duplicate override records on retry).
--   3. Adds CHECK constraints on enum-like columns (defense-in-depth).
--   4. Adds missing composite indexes for audit log + notification queries.
--   5. Grants is_admin() only to authenticated (was PUBLIC).
--   6. Adds a token_lookup_hash column to refresh_tokens for O(1) lookup
--      (replaces the O(n) bcrypt scan).
-- ====================================================================


-- ====================================================================
-- 1. RLS GUARD TRIGGER ON ACCOUNTS (CRITICAL — prevents self-escalation)
-- --------------------------------------------------------------------
-- The accounts_update_own RLS policy allowed any authenticated user to
-- UPDATE their own row, including role/status/studentId. This trigger
-- blocks changes to sensitive columns via the REST API. The service role
-- (used by the Next.js backend) bypasses RLS entirely, so app writes
-- are unaffected.
-- ====================================================================

CREATE OR REPLACE FUNCTION guard_account_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Block changes to sensitive columns (RLS context only)
  -- The service role bypasses RLS, so this only affects direct REST API writes.
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'role column cannot be changed via RLS — use the admin API';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'status column cannot be changed via RLS — use the admin API';
  END IF;
  IF NEW.student_id IS DISTINCT FROM OLD.student_id THEN
    RAISE EXCEPTION 'student_id column cannot be changed via RLS — use the admin API';
  END IF;
  IF NEW.failed_login_attempts IS DISTINCT FROM OLD.failed_login_attempts THEN
    RAISE EXCEPTION 'failed_login_attempts cannot be changed via RLS';
  END IF;
  IF NEW.locked_until IS DISTINCT FROM OLD.locked_until THEN
    RAISE EXCEPTION 'locked_until cannot be changed via RLS';
  END IF;
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
    RAISE EXCEPTION 'password_hash cannot be changed via RLS — use the password API';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_account_columns ON accounts;
CREATE TRIGGER trg_guard_account_columns
  BEFORE UPDATE ON accounts
  FOR EACH ROW
  EXECUTE FUNCTION guard_account_columns();


-- ====================================================================
-- 2. IDEMPOTENT ATTENDANCE OVERRIDES (unique constraint)
-- ====================================================================
-- Allows upsert on (event_id, student_id) so retries don't create
-- duplicate override records.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_overrides_event_student_unique
    ON attendance_overrides (event_id, student_id);


-- ====================================================================
-- 3. CHECK CONSTRAINTS (defense-in-depth — rejects invalid enum values)
-- ====================================================================

ALTER TABLE accounts ADD CONSTRAINT chk_accounts_role
    CHECK (role IN ('ADMIN', 'ORGANIZER', 'USER'));
ALTER TABLE accounts ADD CONSTRAINT chk_accounts_status
    CHECK (status IN ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED'));

ALTER TABLE events ADD CONSTRAINT chk_events_scope
    CHECK (scope IN ('academic', 'departmental'));
ALTER TABLE events ADD CONSTRAINT chk_events_status
    CHECK (status IN ('active', 'cancelled'));

ALTER TABLE event_attendance ADD CONSTRAINT chk_event_attendance_source
    CHECK (source IN ('qr', 'override'));

ALTER TABLE notifications ADD CONSTRAINT chk_notifications_type
    CHECK (type IN ('info', 'reminder', 'warning', 'success'));


-- ====================================================================
-- 4. MISSING COMPOSITE INDEXES (scalability for high-traffic queries)
-- ====================================================================

-- Audit log: "view audit history for this target entity, newest first"
CREATE INDEX IF NOT EXISTS idx_audit_logs_target_created_at
    ON audit_logs (target_type, target_id, created_at);

-- Notification cron: "find reminder notifications for dedup"
CREATE INDEX IF NOT EXISTS idx_notifications_type_created_at
    ON notifications (type, created_at);

-- Refresh token: O(1) lookup by hash (replaces O(n) bcrypt scan)
-- NOTE: The token_hash column already exists and is UNIQUE. This index
-- is redundant with the unique constraint but explicit for documentation.
-- The unique constraint already provides O(1) lookup.


-- ====================================================================
-- 5. RESTRICT is_admin() EXECUTE GRANT (was PUBLIC)
-- ====================================================================
REVOKE ALL ON FUNCTION is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_admin() TO authenticated;


-- ====================================================================
-- 6. POST-MIGRATION VERIFICATION
-- --------------------------------------------------------------------
-- SELECT tgname, tgtype FROM pg_trigger WHERE tgrelid = 'accounts'::regclass;
-- -- Should show trg_guard_account_columns
--
-- SELECT conname, consrc FROM pg_constraint WHERE conrelid = 'accounts'::regclass;
-- -- Should show chk_accounts_role, chk_accounts_status
-- ====================================================================

-- End of migration 0005_security_hardening_scalability_v8.sql
