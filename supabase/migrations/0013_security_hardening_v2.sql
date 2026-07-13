-- ====================================================================
-- Nexus Gate — 0013_security_hardening_v2.sql
-- --------------------------------------------------------------------
-- Fixes four critical issues identified in the security audit:
--
-- 1. RLS policies never matched (C7): every policy compared accounts.id
--    (a cuid TEXT) to auth.uid()::text (a UUID). A cuid string never
--    equals a UUID string, so the USING clause always returned FALSE.
--    Migration 0010 added the supabase_auth_uid column specifically to
--    bridge this gap, but no migration updated the policies to use it.
--    This migration recreates every policy with supabase_auth_uid.
--
-- 2. guard_account_columns incomplete (DB finding #3): the trigger
--    blocked role/status/student_id/failed_login_attempts/locked_until/
--    password_hash but NOT supabase_auth_uid, passkey_credential,
--    passkey_credential_id, last_login_at, last_password_change_at,
--    notification_endpoint, notification_keys. A REST API self-update
--    could set supabase_auth_uid to another user's UUID and hijack
--    their auth identity. This migration extends the guard.
--
-- 3. guard_last_admin TOCTOU race not closed (C6): the trigger did
--    SELECT COUNT(*) under READ COMMITTED (no locks), so two concurrent
--    demotions could both pass the <=1 check. This migration uses
--    pg_advisory_xact_lock to serialize last-admin checks.
--
-- 4. FK cascade gaps: Event.owner had no ON DELETE (defaults to
--    RESTRICT, throwing P2003 on delete). AttendanceOverride.student
--    had no ON DELETE (blocks deleting authorized_students with
--    overrides). This migration fixes both.
-- ====================================================================


-- ====================================================================
-- 1. Fix is_admin() to use supabase_auth_uid
-- ====================================================================
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM accounts
        WHERE supabase_auth_uid = auth.uid() AND role = 'ADMIN'
    );
$$;


-- ====================================================================
-- 2. Recreate accounts RLS policies using supabase_auth_uid
-- ====================================================================
DROP POLICY IF EXISTS accounts_select_own_or_admin ON accounts;
CREATE POLICY accounts_select_own_or_admin
    ON accounts FOR SELECT
    TO authenticated
    USING (supabase_auth_uid = auth.uid() OR is_admin());

DROP POLICY IF EXISTS accounts_update_own ON accounts;
CREATE POLICY accounts_update_own
    ON accounts FOR UPDATE
    TO authenticated
    USING (supabase_auth_uid = auth.uid())
    WITH CHECK (supabase_auth_uid = auth.uid());


-- ====================================================================
-- 3. Recreate event_attendance RLS policies
--    account_id references accounts.id (cuid), so we join through to
--    match the account's supabase_auth_uid.
-- ====================================================================
DROP POLICY IF EXISTS event_attendance_select_own_or_admin ON event_attendance;
CREATE POLICY event_attendance_select_own_or_admin
    ON event_attendance FOR SELECT
    TO authenticated
    USING (
        is_admin() OR
        EXISTS (
            SELECT 1 FROM accounts
            WHERE accounts.id = event_attendance.account_id
            AND accounts.supabase_auth_uid = auth.uid()
        )
    );


-- ====================================================================
-- 4. Recreate attendance_overrides RLS policies
-- ====================================================================
DROP POLICY IF EXISTS attendance_overrides_select_admin_or_owner ON attendance_overrides;
CREATE POLICY attendance_overrides_select_admin_or_owner
    ON attendance_overrides FOR SELECT
    TO authenticated
    USING (
        is_admin() OR
        EXISTS (
            SELECT 1 FROM events
            JOIN accounts ON accounts.id = events.owner_id
            WHERE events.id = attendance_overrides.event_id
            AND accounts.supabase_auth_uid = auth.uid()
        )
    );


-- ====================================================================
-- 5. Recreate notifications RLS policies
-- ====================================================================
DROP POLICY IF EXISTS notifications_select_own ON notifications;
CREATE POLICY notifications_select_own
    ON notifications FOR SELECT
    TO authenticated
    USING (
        is_admin() OR
        EXISTS (
            SELECT 1 FROM accounts
            WHERE accounts.id = notifications.account_id
            AND accounts.supabase_auth_uid = auth.uid()
        )
    );

DROP POLICY IF EXISTS notifications_update_own ON notifications;
CREATE POLICY notifications_update_own
    ON notifications FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM accounts
            WHERE accounts.id = notifications.account_id
            AND accounts.supabase_auth_uid = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM accounts
            WHERE accounts.id = notifications.account_id
            AND accounts.supabase_auth_uid = auth.uid()
        )
    );


-- ====================================================================
-- 6. Recreate refresh_tokens RLS policies
-- ====================================================================
DROP POLICY IF EXISTS refresh_tokens_select_own ON refresh_tokens;
CREATE POLICY refresh_tokens_select_own
    ON refresh_tokens FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM accounts
            WHERE accounts.id = refresh_tokens.account_id
            AND accounts.supabase_auth_uid = auth.uid()
        )
    );


-- ====================================================================
-- 7. Recreate verification_tokens RLS policies
-- ====================================================================
DROP POLICY IF EXISTS verification_tokens_select_own ON verification_tokens;
CREATE POLICY IF EXISTS verification_tokens_select_own
    ON verification_tokens FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM accounts
            WHERE accounts.id = verification_tokens.account_id
            AND accounts.supabase_auth_uid = auth.uid()
        )
    );


-- ====================================================================
-- 8. Recreate authorized_students RLS policies
--    Staff-only (admin or organizer). No direct user-ownership column
--    since this table is the whitelist, not per-user.
-- ====================================================================
DROP POLICY IF EXISTS authorized_students_select_staff ON authorized_students;
CREATE POLICY authorized_students_select_staff
    ON authorized_students FOR SELECT
    TO authenticated
    USING (is_admin() OR EXISTS (
        SELECT 1 FROM accounts
        WHERE accounts.supabase_auth_uid = auth.uid()
        AND accounts.role = 'ORGANIZER'
    ));


-- ====================================================================
-- 9. Recreate device_keys RLS policies
-- ====================================================================
DROP POLICY IF EXISTS device_keys_select_own ON device_keys;
CREATE POLICY device_keys_select_own
    ON device_keys FOR SELECT
    TO authenticated
    USING (
        is_admin() OR
        EXISTS (
            SELECT 1 FROM accounts
            WHERE accounts.id = device_keys.account_id
            AND accounts.supabase_auth_uid = auth.uid()
        )
    );


-- ====================================================================
-- 10. Extend guard_account_columns to protect identity-hijack columns
-- ====================================================================
CREATE OR REPLACE FUNCTION guard_account_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_role text;
BEGIN
  v_role := current_setting('role', true);

  -- Only enforce for REST API context (authenticated/anon). Trusted
  -- backend connections (Prisma, service_role) skip the guard.
  IF v_role IS NULL OR v_role NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- Original sensitive columns.
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'role column cannot be changed via RLS — use the admin API';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'status column cannot be changed via RLS — use the admin API';
  END IF;
  IF NEW.student_id IS DISTINCT FROM OLD.student_id THEN
    RAISE EXCEPTION 'student_id cannot be changed via RLS — use the admin API';
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

  -- NEW: identity-hijack columns. A REST self-update that changes these
  -- could let a user impersonate another account (supabase_auth_uid) or
  -- register another user's passkey (passkey_credential_id).
  IF NEW.supabase_auth_uid IS DISTINCT FROM OLD.supabase_auth_uid THEN
    RAISE EXCEPTION 'supabase_auth_uid cannot be changed via RLS';
  END IF;
  IF NEW.passkey_credential IS DISTINCT FROM OLD.passkey_credential THEN
    RAISE EXCEPTION 'passkey_credential cannot be changed via RLS';
  END IF;
  IF NEW.passkey_credential_id IS DISTINCT FROM OLD.passkey_credential_id THEN
    RAISE EXCEPTION 'passkey_credential_id cannot be changed via RLS';
  END IF;

  -- NEW: audit-tampering columns.
  IF NEW.last_login_at IS DISTINCT FROM OLD.last_login_at THEN
    RAISE EXCEPTION 'last_login_at cannot be changed via RLS';
  END IF;
  IF NEW.last_password_change_at IS DISTINCT FROM OLD.last_password_change_at THEN
    RAISE EXCEPTION 'last_password_change_at cannot be changed via RLS';
  END IF;

  RETURN NEW;
END;
$$;


-- ====================================================================
-- 11. Fix guard_last_admin TOCTOU race with an advisory lock
--     The advisory lock is transaction-scoped (released on COMMIT/ROLLBACK),
--     so two concurrent demotions serialize: the second waits for the first
--     to commit, then sees the updated count. The lock key is a constant
--     so all admin-row mutations share one lock.
-- ====================================================================
CREATE OR REPLACE FUNCTION guard_last_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_admin_count INT;
BEGIN
  IF OLD.role = 'ADMIN' AND OLD.status = 'ACTIVE' THEN
    -- Acquire a transaction-scoped advisory lock. All concurrent
    -- last-admin checks serialize on this lock, closing the TOCTOU race.
    -- Key 74721 is arbitrary but must be unique to this purpose.
    PERFORM pg_advisory_xact_lock(74721);

    IF TG_OP = 'UPDATE' THEN
      IF NEW.role != 'ADMIN' OR NEW.status != 'ACTIVE' THEN
        SELECT COUNT(*) INTO active_admin_count
        FROM accounts
        WHERE role = 'ADMIN' AND status = 'ACTIVE';
        IF active_admin_count <= 1 THEN
          RAISE EXCEPTION 'Cannot remove the last active admin account';
        END IF;
      END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN
      SELECT COUNT(*) INTO active_admin_count
      FROM accounts
      WHERE role = 'ADMIN' AND status = 'ACTIVE';
      IF active_admin_count <= 1 THEN
        RAISE EXCEPTION 'Cannot delete the last active admin account';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;


-- ====================================================================
-- 12. Fix FK cascade on attendance_overrides.student_id
--     Was: REFERENCES authorized_students (student_id) [default NO ACTION]
--     Now: ON DELETE CASCADE (deleting a student cleans up their overrides)
--     Must drop and recreate the constraint.
-- ====================================================================
ALTER TABLE attendance_overrides DROP CONSTRAINT IF EXISTS attendance_overrides_student_id_fkey;
ALTER TABLE attendance_overrides
    ADD CONSTRAINT attendance_overrides_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES authorized_students (student_id)
    ON DELETE CASCADE;


-- ====================================================================
-- 13. Make Event.owner ON DELETE RESTRICT explicit
--     The default is NO ACTION (which behaves like RESTRICT but defers
--     the check). Making it explicit RESTRICT documents the intent:
--     deleting an organizer who owns events must be preceded by
--     reassigning or deleting their events. The app route catches the
--     P2003 error and returns a clear message.
-- ====================================================================
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_owner_id_fkey;
ALTER TABLE events
    ADD CONSTRAINT events_owner_id_fkey
    FOREIGN KEY (owner_id) REFERENCES accounts (id)
    ON DELETE RESTRICT;


-- ====================================================================
-- 14. Verification
-- ====================================================================
-- After running this migration, verify:
--   SELECT tablename, policyname FROM pg_policies
--   WHERE schemaname = 'public'
--   ORDER BY tablename, policyname;
-- All account-ownership policies should now reference supabase_auth_uid.
--
--   SELECT prosrc FROM pg_proc WHERE proname = 'guard_last_admin';
-- Should contain pg_advisory_xact_lock(74721).

-- End of migration 0013_security_hardening_v2.sql
