-- ====================================================================
-- Nexus Gate — 0007_fix_rls_auth_uid_type_cast.sql
-- --------------------------------------------------------------------
-- FIX: auth.uid() returns UUID, but accounts.id (and all *_account_id
-- foreign keys) are TEXT (cuid). PostgreSQL cannot compare TEXT = UUID
-- without an explicit cast. This migration recreates ALL RLS policies
-- with `auth.uid()::text` so the comparison works.
--
-- This is a DROP + RECREATE of every policy that uses auth.uid().
-- ====================================================================


-- ====================================================================
-- 1. Fix is_admin() function
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
        WHERE id = auth.uid()::text AND role = 'ADMIN'
    );
$$;


-- ====================================================================
-- 2. Fix accounts RLS policies
-- ====================================================================
DROP POLICY IF EXISTS accounts_select_own_or_admin ON accounts;
CREATE POLICY accounts_select_own_or_admin
    ON accounts FOR SELECT
    TO authenticated
    USING (id = auth.uid()::text OR is_admin());

DROP POLICY IF EXISTS accounts_update_own ON accounts;
CREATE POLICY accounts_update_own
    ON accounts FOR UPDATE
    TO authenticated
    USING (id = auth.uid()::text)
    WITH CHECK (id = auth.uid()::text);


-- ====================================================================
-- 3. Fix event_attendance RLS policies
-- ====================================================================
DROP POLICY IF EXISTS event_attendance_select_own_or_admin ON event_attendance;
CREATE POLICY event_attendance_select_own_or_admin
    ON event_attendance FOR SELECT
    TO authenticated
    USING (account_id = auth.uid()::text OR is_admin());


-- ====================================================================
-- 4. Fix attendance_overrides RLS policies
-- ====================================================================
DROP POLICY IF EXISTS attendance_overrides_select_admin_or_owner ON attendance_overrides;
CREATE POLICY attendance_overrides_select_admin_or_owner
    ON attendance_overrides FOR SELECT
    TO authenticated
    USING (
        is_admin() OR
        EXISTS (
            SELECT 1 FROM events
            WHERE events.id = attendance_overrides.event_id
            AND events.owner_id = auth.uid()::text
        )
    );


-- ====================================================================
-- 5. Fix notifications RLS policies
-- ====================================================================
DROP POLICY IF EXISTS notifications_select_own ON notifications;
CREATE POLICY notifications_select_own
    ON notifications FOR SELECT
    TO authenticated
    USING (account_id = auth.uid()::text);

DROP POLICY IF EXISTS notifications_update_own ON notifications;
CREATE POLICY notifications_update_own
    ON notifications FOR UPDATE
    TO authenticated
    USING (account_id = auth.uid()::text)
    WITH CHECK (account_id = auth.uid()::text);


-- ====================================================================
-- 6. Fix refresh_tokens RLS policies
-- ====================================================================
DROP POLICY IF EXISTS refresh_tokens_select_own ON refresh_tokens;
CREATE POLICY refresh_tokens_select_own
    ON refresh_tokens FOR SELECT
    TO authenticated
    USING (account_id = auth.uid()::text);


-- ====================================================================
-- 7. Fix verification_tokens RLS policies
-- ====================================================================
DROP POLICY IF EXISTS verification_tokens_select_own ON verification_tokens;
CREATE POLICY verification_tokens_select_own
    ON verification_tokens FOR SELECT
    TO authenticated
    USING (account_id = auth.uid()::text);


-- ====================================================================
-- 8. Fix authorized_students RLS policies
-- ====================================================================
DROP POLICY IF EXISTS authorized_students_select_staff ON authorized_students;
CREATE POLICY authorized_students_select_staff
    ON authorized_students FOR SELECT
    TO authenticated
    USING (is_admin() OR EXISTS (
        SELECT 1 FROM accounts
        WHERE accounts.id = auth.uid()::text AND accounts.role = 'ORGANIZER'
    ));


-- ====================================================================
-- 9. Fix device_keys RLS policies
-- ====================================================================
DROP POLICY IF EXISTS device_keys_select_own ON device_keys;
CREATE POLICY device_keys_select_own
    ON device_keys FOR SELECT
    TO authenticated
    USING (account_id = auth.uid()::text);


-- ====================================================================
-- 10. Verification
-- --------------------------------------------------------------------
-- After running this migration, verify with:
-- SELECT tablename, policyname, qual FROM pg_policies
-- WHERE schemaname = 'public' AND qual LIKE '%auth.uid()%';
-- All results should show auth.uid()::text
-- ====================================================================

-- End of migration 0007_fix_rls_auth_uid_type_cast.sql
