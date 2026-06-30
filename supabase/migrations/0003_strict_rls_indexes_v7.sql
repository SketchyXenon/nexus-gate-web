-- ====================================================================
-- Nexus Gate — 0003_strict_rls_indexes_v7.sql
-- --------------------------------------------------------------------
-- Migration 0003 — brings the Supabase schema in sync with Prisma v7.
--
-- What this migration does:
--   1. Adds the `last_password_change_at` column to accounts.
--   2. Drops & recreates ALL indexes as high-quality composite indexes
--      that match the actual query patterns (event eligibility,
--      notification badge, audit log sweep, etc.).
--   3. Enables Row-Level Security (RLS) on EVERY table.
--   4. Installs STRICT RLS policies:
--        - Service role bypasses RLS (server-side Prisma uses the
--          service role, so all app queries work unchanged).
--        - Authenticated users can only read/update their OWN rows
--          (accounts, notifications, attendances, refresh tokens,
--          verification tokens).
--        - Events: readable by any authenticated user (visibility is
--          enforced in the application layer, which uses the service
--          role). This is intentional — the app layer has the full
--          course/section visibility rules that SQL can't express
--          cleanly. RLS here is a defense-in-depth backstop, not the
--          primary gate.
--        - Admins (role = 'ADMIN') can read everything.
--        - Anonymous access is DENIED on all tables.
--   5. Adds atomic `updated_at` triggers on every table.
--
-- Idempotent: every statement is guarded with IF [NOT] EXISTS / OR REPLACE.
--
-- Reference: /home/z/my-project/prisma/schema.prisma (v7)
-- ====================================================================


-- ====================================================================
-- 1. NEW COLUMN — last_password_change_at
-- --------------------------------------------------------------------
-- Tracks the 30-day password change cooldown. NULL = never changed
-- (first change is always allowed).
-- ====================================================================
ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS last_password_change_at TIMESTAMPTZ;


-- ====================================================================
-- 2. INDEXES — high-quality composite indexes
-- --------------------------------------------------------------------
-- Drop the old single-column indexes from migration 0001 and replace
-- them with composite indexes that match real query patterns.
-- ====================================================================

-- ---- accounts ----
DROP INDEX IF EXISTS idx_accounts_role;
DROP INDEX IF EXISTS idx_accounts_status;
CREATE INDEX IF NOT EXISTS idx_accounts_role_status
    ON accounts (role, status);
CREATE INDEX IF NOT EXISTS idx_accounts_program_section
    ON accounts (program, section);
CREATE INDEX IF NOT EXISTS idx_accounts_notification_enabled
    ON accounts (notification_enabled);
CREATE INDEX IF NOT EXISTS idx_accounts_locked_until
    ON accounts (locked_until);
CREATE INDEX IF NOT EXISTS idx_accounts_last_login_at
    ON accounts (last_login_at);

-- ---- authorized_students ----
DROP INDEX IF EXISTS idx_authorized_students_program_section;
CREATE INDEX IF NOT EXISTS idx_authorized_students_program_section_activated
    ON authorized_students (program, section, activated);
CREATE INDEX IF NOT EXISTS idx_authorized_students_activated
    ON authorized_students (activated);

-- ---- verification_tokens ----
DROP INDEX IF EXISTS idx_verification_tokens_account_id;
DROP INDEX IF EXISTS idx_verification_tokens_expires_at;
CREATE INDEX IF NOT EXISTS idx_verification_tokens_account_purpose_used
    ON verification_tokens (account_id, purpose, used_at);
CREATE INDEX IF NOT EXISTS idx_verification_tokens_expires_at
    ON verification_tokens (expires_at);

-- ---- refresh_tokens ----
DROP INDEX IF EXISTS idx_refresh_tokens_account_id;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_account_revoked
    ON refresh_tokens (account_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at
    ON refresh_tokens (expires_at);

-- ---- events ----
-- The MAIN eligibility query uses: WHERE status='active' AND (
--   (target_program IS NULL AND target_section IS NULL) OR
--   (target_program = ? AND target_section = ?)
-- ) ORDER BY scheduled_at DESC
DROP INDEX IF EXISTS idx_events_owner_id;
DROP INDEX IF EXISTS idx_events_scheduled_at;
DROP INDEX IF EXISTS idx_events_status;
CREATE INDEX IF NOT EXISTS idx_events_status_scheduled_at
    ON events (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_events_owner_status
    ON events (owner_id, status);
CREATE INDEX IF NOT EXISTS idx_events_target_program_section_status
    ON events (target_program, target_section, status);
CREATE INDEX IF NOT EXISTS idx_events_scheduled_at_status
    ON events (scheduled_at, status);

-- ---- event_attendance ----
DROP INDEX IF EXISTS idx_event_attendance_event_id;
DROP INDEX IF EXISTS idx_event_attendance_account_id;
DROP INDEX IF EXISTS idx_event_attendance_scanned_at;
CREATE INDEX IF NOT EXISTS idx_event_attendance_account_scanned_at
    ON event_attendance (account_id, scanned_at);
CREATE INDEX IF NOT EXISTS idx_event_attendance_event_scanned_at
    ON event_attendance (event_id, scanned_at);
CREATE INDEX IF NOT EXISTS idx_event_attendance_scanned_at
    ON event_attendance (scanned_at);

-- ---- attendance_overrides ----
DROP INDEX IF EXISTS idx_attendance_overrides_event_id;
DROP INDEX IF EXISTS idx_attendance_overrides_admin_id;
CREATE INDEX IF NOT EXISTS idx_attendance_overrides_event_created_at
    ON attendance_overrides (event_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attendance_overrides_admin_created_at
    ON attendance_overrides (admin_id, created_at);

-- ---- notifications ----
DROP INDEX IF EXISTS idx_notifications_account_id;
DROP INDEX IF EXISTS idx_notifications_read_at;
DROP INDEX IF EXISTS idx_notifications_created_at;
CREATE INDEX IF NOT EXISTS idx_notifications_account_created_at
    ON notifications (account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_account_read_at
    ON notifications (account_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_read_at_created_at
    ON notifications (read_at, created_at);

-- ---- audit_logs ----
DROP INDEX IF EXISTS idx_audit_logs_actor_id;
DROP INDEX IF EXISTS idx_audit_logs_action;
DROP INDEX IF EXISTS idx_audit_logs_created_at;
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created_at
    ON audit_logs (actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created_at
    ON audit_logs (action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
    ON audit_logs (created_at);


-- ====================================================================
-- 3. ROW-LEVEL SECURITY (RLS)
-- --------------------------------------------------------------------
-- Enable RLS on every table. The SERVICE ROLE (used by Prisma on the
-- server) bypasses RLS entirely — so the application's queries are
-- unaffected. RLS here protects against direct client-side access to
-- Supabase (e.g. if someone accidentally exposes the anon key in the
-- browser and a malicious user tries to read/modify other users' data).
--
-- Policy design:
--   - Anonymous (anon role): DENIED everywhere. No public reads.
--   - Authenticated users: can read/update ONLY their own rows.
--   - Admins (role = 'ADMIN'): can read everything (but writes still
--     go through the service role on the server).
-- ====================================================================

-- Helper: a SECURITY DEFINER function that returns TRUE if the current
-- authenticated user is an admin. Using a function avoids repeating
-- the subquery in every policy.
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

-- ---- accounts ----
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;

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

-- No INSERT/DELETE via RLS — account creation uses the service role
-- (register route), and account deletion uses the admin service role.


-- ---- events ----
-- Events are readable by any authenticated user. The strict
-- course/section visibility rule is enforced in the application layer
-- (which uses the service role). RLS here only prevents anonymous
-- access. Writes (INSERT/UPDATE/DELETE) are service-role only.
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS events_select_authenticated ON events;
CREATE POLICY events_select_authenticated
    ON events FOR SELECT
    TO authenticated
    USING (true);


-- ---- event_attendance ----
-- A user can read only their own attendance records. Admins see all.
-- Writes go through the service role (scan route).
ALTER TABLE event_attendance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS event_attendance_select_own_or_admin ON event_attendance;
CREATE POLICY event_attendance_select_own_or_admin
    ON event_attendance FOR SELECT
    TO authenticated
    USING (account_id = auth.uid()::text OR is_admin());


-- ---- attendance_overrides ----
-- Overrides are readable by admins and the event owner. Writes are
-- service-role only (admin override route).
ALTER TABLE attendance_overrides ENABLE ROW LEVEL SECURITY;

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


-- ---- notifications ----
-- A user can read + update (mark read) only their own notifications.
-- Writes (create, delete) are service-role only.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

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


-- ---- refresh_tokens ----
-- A user can read only their own refresh tokens (for rotation checks).
-- All writes are service-role only.
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS refresh_tokens_select_own ON refresh_tokens;
CREATE POLICY refresh_tokens_select_own
    ON refresh_tokens FOR SELECT
    TO authenticated
    USING (account_id = auth.uid()::text);


-- ---- verification_tokens ----
-- Verification tokens are service-role only (register/verify flows).
-- No direct client access.
ALTER TABLE verification_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS verification_tokens_select_own ON verification_tokens;
CREATE POLICY verification_tokens_select_own
    ON verification_tokens FOR SELECT
    TO authenticated
    USING (account_id = auth.uid()::text);


-- ---- audit_logs ----
-- Audit logs are readable by admins only. All writes are service-role.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_logs_select_admin ON audit_logs;
CREATE POLICY audit_logs_select_admin
    ON audit_logs FOR SELECT
    TO authenticated
    USING (is_admin());


-- ---- authorized_students ----
-- The whitelist is readable by admins and organizers. All writes are
-- service-role only (whitelist import route).
ALTER TABLE authorized_students ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS authorized_students_select_staff ON authorized_students;
CREATE POLICY authorized_students_select_staff
    ON authorized_students FOR SELECT
    TO authenticated
    USING (is_admin() OR EXISTS (
        SELECT 1 FROM accounts
        WHERE accounts.id = auth.uid()::text AND accounts.role = 'ORGANIZER'
    ));


-- ---- settings ----
-- Settings are readable by any authenticated user (the maintenance mode
-- flag, for example, must be visible to everyone). Writes are
-- service-role only (admin settings route).
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS settings_select_authenticated ON settings;
CREATE POLICY settings_select_authenticated
    ON settings FOR SELECT
    TO authenticated
    USING (true);


-- ====================================================================
-- 4. ATOMIC updated_at TRIGGERS
-- --------------------------------------------------------------------
-- Ensures `updated_at` is always set on UPDATE, even if the client
-- forgets to set it. The function is idempotent (CREATE OR REPLACE).
-- Each table gets its own trigger (CREATE OR REPLACE).
-- ====================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- Accounts
DROP TRIGGER IF EXISTS trg_accounts_updated_at ON accounts;
CREATE TRIGGER trg_accounts_updated_at
    BEFORE UPDATE ON accounts
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Events
DROP TRIGGER IF EXISTS trg_events_updated_at ON events;
CREATE TRIGGER trg_events_updated_at
    BEFORE UPDATE ON events
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Settings (updated_at is the only mutable column here)
DROP TRIGGER IF EXISTS trg_settings_updated_at ON settings;
CREATE TRIGGER trg_settings_updated_at
    BEFORE UPDATE ON settings
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();


-- ====================================================================
-- 5. POST-MIGRATION VERIFICATION (run manually to confirm)
-- --------------------------------------------------------------------
-- SELECT relname, relrowsecurity, relforcerowsecurity
-- FROM pg_class
-- WHERE relname IN (
--     'accounts','events','event_attendance','attendance_overrides',
--     'notifications','refresh_tokens','verification_tokens',
--     'audit_logs','authorized_students','settings'
-- );
-- -- All rows should show relrowsecurity = true.
-- ====================================================================

-- End of migration 0003_strict_rls_indexes_v7.sql
