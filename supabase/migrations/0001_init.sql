-- ====================================================================
-- Nexus Gate — 0001_init.sql
-- --------------------------------------------------------------------
-- Complete initial schema for the Nexus Gate attendance system.
-- Target: Supabase (PostgreSQL 15+). Paste into the Supabase SQL Editor.
--
-- Conventions:
--   * snake_case column names (Prisma maps camelCase model fields to these).
--   * PostgreSQL-native types: TEXT, INTEGER, BOOLEAN, TIMESTAMPTZ, SERIAL.
--   * Idempotent: every object is guarded with IF NOT EXISTS / OR REPLACE.
--   * Commented DROP statements at the top for full tear-down.
--
-- Reference: /home/z/my-project/prisma/schema.prisma (v5)
-- ====================================================================


-- ====================================================================
-- OPTIONAL TEAR-DOWN — uncomment to wipe everything before re-creating.
-- (Destructive — only run on fresh databases or when you mean it.)
-- ====================================================================
-- DROP VIEW IF EXISTS v_attendance_detail CASCADE;
-- DROP VIEW IF EXISTS v_accounts_detail   CASCADE;
-- DROP VIEW IF EXISTS v_event_summary     CASCADE;
-- DROP TABLE IF EXISTS attendance_overrides   CASCADE;
-- DROP TABLE IF EXISTS event_attendance       CASCADE;
-- DROP TABLE IF EXISTS notifications          CASCADE;
-- DROP TABLE IF EXISTS audit_logs             CASCADE;
-- DROP TABLE IF EXISTS verification_tokens    CASCADE;
-- DROP TABLE IF EXISTS refresh_tokens         CASCADE;
-- DROP TABLE IF EXISTS events                 CASCADE;
-- DROP TABLE IF EXISTS authorized_students    CASCADE;
-- DROP TABLE IF EXISTS accounts               CASCADE;
-- DROP TABLE IF EXISTS settings               CASCADE;
-- DROP FUNCTION IF EXISTS set_updated_at()    CASCADE;


-- ====================================================================
-- 1. ACCOUNTS
-- --------------------------------------------------------------------
-- Mirrors Prisma `Account`. id is TEXT (cuid) — application generates it.
-- email and student_id are UNIQUE. Indexes mirror @@index annotations.
-- ====================================================================
CREATE TABLE IF NOT EXISTS accounts (
    id                       TEXT        PRIMARY KEY,
    email                    TEXT        NOT NULL UNIQUE,
    password_hash            TEXT        NOT NULL DEFAULT '',
    full_name                TEXT        NOT NULL,
    role                     TEXT        NOT NULL DEFAULT 'USER',
    status                   TEXT        NOT NULL DEFAULT 'PENDING_VERIFICATION',
    student_id               INTEGER     UNIQUE,
    program                  TEXT,
    section                  TEXT,
    auth_provider            TEXT,
    provider_account_id      TEXT,
    year                     INTEGER,
    organization_name        TEXT,
    course_modified_at       TIMESTAMPTZ,
    last_profile_update_at   TIMESTAMPTZ,
    notification_endpoint    TEXT,
    notification_keys        TEXT,
    notification_enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
    last_login_at            TIMESTAMPTZ,
    failed_login_attempts    INTEGER     NOT NULL DEFAULT 0,
    locked_until             TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accounts_role   ON accounts (role);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts (status);


-- ====================================================================
-- 2. AUTHORIZED STUDENTS
-- --------------------------------------------------------------------
-- Optional admin whitelist. Not a hard gate — overrides reference it.
-- ====================================================================
CREATE TABLE IF NOT EXISTS authorized_students (
    student_id   INTEGER  PRIMARY KEY,
    email        TEXT     NOT NULL UNIQUE,
    full_name    TEXT     NOT NULL,
    program      TEXT     NOT NULL,
    section      TEXT     NOT NULL,
    activated    BOOLEAN  NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_authorized_students_program_section
    ON authorized_students (program, section);


-- ====================================================================
-- 3. VERIFICATION TOKENS  (OTP / email verification)
-- ====================================================================
CREATE TABLE IF NOT EXISTS verification_tokens (
    id          TEXT        PRIMARY KEY,
    account_id  TEXT        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    code_hash   TEXT        NOT NULL,
    purpose     TEXT        NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    attempts    INTEGER     NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_verification_tokens_account_id ON verification_tokens (account_id);
CREATE INDEX IF NOT EXISTS idx_verification_tokens_expires_at ON verification_tokens (expires_at);


-- ====================================================================
-- 4. REFRESH TOKENS  (rotating JWT refresh tokens)
-- ====================================================================
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          TEXT        PRIMARY KEY,
    account_id  TEXT        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    token_hash  TEXT        NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_account_id ON refresh_tokens (account_id);


-- ====================================================================
-- 5. EVENTS
-- ====================================================================
CREATE TABLE IF NOT EXISTS events (
    id                   SERIAL       PRIMARY KEY,
    title                TEXT         NOT NULL,
    description          TEXT,
    event_secret         TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    owner_id             TEXT         NOT NULL REFERENCES accounts (id),
    scope                TEXT         NOT NULL DEFAULT 'academic',
    target_program       TEXT,
    target_section       TEXT,
    scheduled_at         TIMESTAMPTZ  NOT NULL,
    ends_at              TIMESTAMPTZ,
    check_in_opens_at    TIMESTAMPTZ,
    check_in_closes_at   TIMESTAMPTZ,
    time_out_opens_at    TIMESTAMPTZ,
    time_out_closes_at   TIMESTAMPTZ,
    enable_time_out      BOOLEAN      NOT NULL DEFAULT FALSE,
    delegatable          BOOLEAN      NOT NULL DEFAULT TRUE,
    status               TEXT         NOT NULL DEFAULT 'active',
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_owner_id     ON events (owner_id);
CREATE INDEX IF NOT EXISTS idx_events_scheduled_at ON events (scheduled_at);
CREATE INDEX IF NOT EXISTS idx_events_status       ON events (status);


-- ====================================================================
-- 6. EVENT ATTENDANCE
-- --------------------------------------------------------------------
-- UNIQUE (event_id, account_id) prevents duplicate check-ins.
-- idempotency_key is UNIQUE for safe retries from offline scans.
-- ====================================================================
CREATE TABLE IF NOT EXISTS event_attendance (
    id              SERIAL       PRIMARY KEY,
    event_id        INTEGER      NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    account_id      TEXT         NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    scanned_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    time_out_at     TIMESTAMPTZ,
    source          TEXT         NOT NULL DEFAULT 'qr',
    idempotency_key TEXT         UNIQUE,
    token_block     INTEGER,
    UNIQUE (event_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_event_attendance_event_id   ON event_attendance (event_id);
CREATE INDEX IF NOT EXISTS idx_event_attendance_account_id ON event_attendance (account_id);
CREATE INDEX IF NOT EXISTS idx_event_attendance_scanned_at ON event_attendance (scanned_at);


-- ====================================================================
-- 7. ATTENDANCE OVERRIDES  (manual safety net)
-- ====================================================================
CREATE TABLE IF NOT EXISTS attendance_overrides (
    id          SERIAL       PRIMARY KEY,
    event_id    INTEGER      NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    admin_id    TEXT         NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    student_id  INTEGER      NOT NULL REFERENCES authorized_students (student_id),
    reason      TEXT         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attendance_overrides_event_id ON attendance_overrides (event_id);
CREATE INDEX IF NOT EXISTS idx_attendance_overrides_admin_id ON attendance_overrides (admin_id);


-- ====================================================================
-- 8. NOTIFICATIONS
-- ====================================================================
CREATE TABLE IF NOT EXISTS notifications (
    id          SERIAL       PRIMARY KEY,
    account_id  TEXT         NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    title       TEXT         NOT NULL,
    body        TEXT         NOT NULL,
    type        TEXT         NOT NULL DEFAULT 'info',
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_account_id ON notifications (account_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read_at    ON notifications (read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at);


-- ====================================================================
-- 9. AUDIT LOGS
-- --------------------------------------------------------------------
-- actor_id ON DELETE SET NULL keeps history even after account deletion.
-- metadata is JSONB for queryability (Prisma stores it as TEXT/JSON string).
-- ====================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id          SERIAL       PRIMARY KEY,
    actor_id    TEXT         REFERENCES accounts (id) ON DELETE SET NULL,
    action      TEXT         NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    metadata    JSONB,
    ip_address  TEXT,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id  ON audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action    ON audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at);


-- ====================================================================
-- 10. SETTINGS  (key/value store — maintenance mode, etc.)
-- ====================================================================
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT        PRIMARY KEY,
    value      TEXT        NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ====================================================================
-- TRIGGER: set_updated_at()  — auto-stamp updated_at on row change.
-- Applied to: accounts, events, settings.
-- ====================================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_accounts_updated_at ON accounts;
CREATE TRIGGER trg_accounts_updated_at
    BEFORE UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_events_updated_at ON events;
CREATE TRIGGER trg_events_updated_at
    BEFORE UPDATE ON events
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_settings_updated_at ON settings;
CREATE TRIGGER trg_settings_updated_at
    BEFORE UPDATE ON settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ====================================================================
-- ROW LEVEL SECURITY
-- --------------------------------------------------------------------
-- Enable RLS on every table. Supabase uses the Postgres role of the
-- API caller (service_role bypasses RLS; anon/authenticated do not).
-- The application talks to Supabase via the service_role key, so all
-- policy enforcement happens in the Next.js API routes (RBAC layer).
--
-- For direct Supabase client access you'd add per-table policies here;
-- the Nexus Gate app does not rely on those, so we leave RLS enabled
-- with NO policies (deny-by-default for anon/authenticated roles).
-- ====================================================================
ALTER TABLE accounts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE authorized_students  ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_tokens  ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens       ENABLE ROW LEVEL SECURITY;
ALTER TABLE events               ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_attendance     ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications        ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings             ENABLE ROW LEVEL SECURITY;


-- ====================================================================
-- DEFAULT SETTINGS  (idempotent upserts)
-- ====================================================================
INSERT INTO settings (key, value) VALUES
    ('maintenance_mode',    'false'),
    ('maintenance_message', 'The system is under maintenance. Please check back later.')
ON CONFLICT (key) DO NOTHING;


-- ====================================================================
-- BOOTSTRAP ADMIN ACCOUNT
-- --------------------------------------------------------------------
-- A seed admin so the system is usable immediately after migration.
-- CHANGE THE PASSWORD on first login (or delete this row and use
-- `bun run bootstrap:admin` with your own credentials instead).
-- Hash: bcrypt, 12 rounds (compatible with src/lib/auth.ts hashPassword)
-- ====================================================================
INSERT INTO accounts (
    id, email, password_hash, full_name, role, status, last_login_at
) VALUES (
    'bootstrap-admin-0001',
    'admin@ctu.edu.ph',
    '$2b$12$TyKoZ7xca222PRGY/Ni8teAqrJRTWvEcZnMfAVmRbS.P4o7BTUaNS',
    'Dr. Amelia Cortez',
    'ADMIN',
    'ACTIVE',
    now()
)
ON CONFLICT (email) DO NOTHING;


-- ====================================================================
-- HELPFUL VIEWS
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
-- END OF 0001_init.sql
-- ====================================================================
