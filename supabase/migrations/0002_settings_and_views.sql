-- ====================================================================
-- Nexus Gate — 0002_settings_and_views.sql
-- --------------------------------------------------------------------
-- Incremental migration for EXISTING deployments that were created
-- before the settings table / organization_name / delegatable columns
-- were introduced. Safe to run multiple times (fully idempotent).
--
-- If 0001_init.sql was already applied, this is a no-op — every
-- statement is guarded with IF NOT EXISTS / OR REPLACE / ON CONFLICT.
-- ====================================================================


-- ====================================================================
-- 1. SETTINGS TABLE  (key/value store — maintenance mode, etc.)
-- ====================================================================
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT        PRIMARY KEY,
    value      TEXT        NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ====================================================================
-- 2. ADD MISSING COLUMNS TO EXISTING TABLES
-- --------------------------------------------------------------------
-- organization_name on accounts (added in schema v5).
-- delegatable on events (added in schema v5).
-- ====================================================================
ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS organization_name TEXT;

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS delegatable BOOLEAN NOT NULL DEFAULT TRUE;


-- ====================================================================
-- 3. UPDATED_AT TRIGGER ON SETTINGS
-- --------------------------------------------------------------------
-- If 0001 didn't create the trigger function yet, define it now.
-- CREATE OR REPLACE FUNCTION is idempotent; the trigger is DROP + CREATE
-- so re-running never errors.
-- ====================================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_settings_updated_at ON settings;
CREATE TRIGGER trg_settings_updated_at
    BEFORE UPDATE ON settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ====================================================================
-- 4. ENABLE RLS ON SETTINGS  (in case the table was created here)
-- ====================================================================
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;


-- ====================================================================
-- 5. DEFAULT MAINTENANCE SETTINGS
-- --------------------------------------------------------------------
-- maintenance_mode    = 'false' (string — app casts to boolean)
-- maintenance_message = shown to users when maintenance_mode = 'true'
-- ====================================================================
INSERT INTO settings (key, value) VALUES
    ('maintenance_mode',    'false'),
    ('maintenance_message', 'The system is under maintenance. Please check back later.')
ON CONFLICT (key) DO NOTHING;


-- ====================================================================
-- 6. HELPFUL VIEWS  (created or replaced on every run)
-- ====================================================================

-- v_attendance_detail — one row per attendance record joined with
-- event + account context. Powers the attendance roster UI.
CREATE OR REPLACE VIEW v_attendance_detail AS
SELECT
    ea.id                       AS attendance_id,
    ea.event_id,
    e.title                     AS event_title,
    e.scope                     AS event_scope,
    e.target_program,
    e.target_section,
    e.scheduled_at              AS event_scheduled_at,
    ea.account_id,
    a.email,
    a.full_name,
    a.role,
    a.student_id,
    a.program                   AS attendee_program,
    a.section                   AS attendee_section,
    ea.scanned_at,
    ea.time_out_at,
    ea.source,
    ea.token_block,
    CASE
        WHEN ea.time_out_at IS NOT NULL THEN 'timed_out'
        ELSE 'checked_in'
    END                         AS attendance_state
FROM event_attendance ea
JOIN events   e ON e.id = ea.event_id
JOIN accounts a ON a.id = ea.account_id;

-- v_accounts_detail — account roster with human-friendly flags.
CREATE OR REPLACE VIEW v_accounts_detail AS
SELECT
    a.id,
    a.email,
    a.full_name,
    a.role,
    a.status,
    a.student_id,
    a.program,
    a.section,
    a.year,
    a.organization_name,
    a.auth_provider,
    a.notification_enabled,
    a.failed_login_attempts,
    a.locked_until,
    a.last_login_at,
    a.created_at,
    a.updated_at,
    CASE
        WHEN a.locked_until IS NOT NULL AND a.locked_until > now() THEN TRUE
        ELSE FALSE
    END                         AS is_locked,
    CASE
        WHEN a.status = 'ACTIVE' THEN TRUE
        ELSE FALSE
    END                         AS is_active
FROM accounts a;

-- v_event_summary — per-event counts for dashboard cards.
CREATE OR REPLACE VIEW v_event_summary AS
SELECT
    e.id                        AS event_id,
    e.title,
    e.scope,
    e.target_program,
    e.target_section,
    e.scheduled_at,
    e.ends_at,
    e.status,
    e.owner_id,
    o.email                     AS owner_email,
    o.full_name                 AS owner_name,
    (SELECT count(*) FROM event_attendance ea WHERE ea.event_id = e.id)
                                AS attendance_count,
    (SELECT count(*) FROM attendance_overrides ao WHERE ao.event_id = e.id)
                                AS override_count,
    (SELECT count(*) FROM event_attendance ea
       WHERE ea.event_id = e.id AND ea.time_out_at IS NOT NULL)
                                AS timed_out_count
FROM events e
JOIN accounts o ON o.id = e.owner_id;


-- ====================================================================
-- END OF 0002_settings_and_views.sql
-- ====================================================================
