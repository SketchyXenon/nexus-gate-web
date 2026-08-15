-- ====================================================================
-- Nexus Gate - TiDB Schema (MySQL-compatible, v16)
-- --------------------------------------------------------------------
-- REFERENCE DDL mirroring prisma/schema.tidb.prisma field-for-field.
-- This is the TiDB equivalent of Supabase migrations 0001-0020.
--
-- PREFERRED: create the schema via
--   bun run db:push:tidb
-- which runs `prisma db push --schema=prisma/schema.tidb.prisma` and
-- handles index creation, FK ordering, and idempotency automatically.
--
-- This SQL file is for DBAs who want to apply DDL manually in the TiDB
-- SQL Editor (Chat2Query). When pasting into the TiDB SQL Editor:
--   - Run each CREATE TABLE block ONE AT A TIME (highlight + Cmd/Ctrl+Enter).
--     The TiDB web editor does not reliably batch multiple semicolon-
--     separated statements in a single Run.
--   - All indexes are declared INLINE inside each CREATE TABLE (TiDB's
--     parser handles inline KEY/INDEX declarations more reliably than
--     standalone CREATE INDEX statements after the table).
--   - Foreign keys are declared inline too.
--
-- What is NOT here (stays on Supabase):
--   - auth.users, auth.refresh_tokens (Supabase Auth owns these)
--   - RLS policies (TiDB has no RLS - authz is enforced in the app layer
--     via requireAuth(); see docs/tidb-migration-runbook.md)
--   - Postgres triggers (accounts self-escalation guard is replaced by
--     requireAuth('ADMIN') on admin routes)
--
-- Type notes:
--   - BOOLEAN is a TiDB alias for TINYINT(1); values are 0/1.
--   - TIMESTAMP stores UTC; the app converts to local for display.
--     Nullable TIMESTAMPs use explicit `NULL DEFAULT NULL` so TiDB does
--     not implicitly apply NOT NULL + ON UPDATE CURRENT_TIMESTAMP.
--   - VARCHAR lengths sized to fit utf8mb4 (4 bytes/char) within the
--     3072-byte index limit. Long free-text uses TEXT (64KB) or
--     LONGTEXT (4GB) to mirror Postgres TEXT (unlimited).
-- ====================================================================

-- ---- 1. ACCOUNTS ---------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id                    VARCHAR(128) PRIMARY KEY,
  email                 VARCHAR(255) NOT NULL,
  password_hash         VARCHAR(255) NOT NULL DEFAULT '',
  full_name             VARCHAR(255) NOT NULL,
  role                  VARCHAR(32) NOT NULL DEFAULT 'USER',
  status                VARCHAR(48) NOT NULL DEFAULT 'PENDING_VERIFICATION',
  student_id            INT NULL DEFAULT NULL,
  program               VARCHAR(64) NULL DEFAULT NULL,
  section               VARCHAR(32) NULL DEFAULT NULL,
  auth_provider         VARCHAR(64) NULL DEFAULT NULL,
  provider_account_id   VARCHAR(128) NULL DEFAULT NULL,
  year                  INT NULL DEFAULT NULL,
  organization_name     VARCHAR(255) NULL DEFAULT NULL,
  course_modified_at    TIMESTAMP NULL DEFAULT NULL,
  last_profile_update_at TIMESTAMP NULL DEFAULT NULL,
  last_password_change_at TIMESTAMP NULL DEFAULT NULL,
  notification_endpoint VARCHAR(500) NULL DEFAULT NULL,
  notification_keys     TEXT NULL,
  passkey_credential    LONGTEXT NULL,
  passkey_credential_id VARCHAR(255) NULL DEFAULT NULL,
  supabase_auth_uid     VARCHAR(128) NULL DEFAULT NULL,
  notification_enabled  TINYINT(1) NOT NULL DEFAULT 0,
  notification_prefs    JSON NULL,
  last_login_at         TIMESTAMP NULL DEFAULT NULL,
  failed_login_attempts INT NOT NULL DEFAULT 0,
  locked_until          TIMESTAMP NULL DEFAULT NULL,
  email_verified_at     TIMESTAMP NULL DEFAULT NULL,
  is_deactivated        TINYINT(1) NOT NULL DEFAULT 0,
  deactivated_at        TIMESTAMP NULL DEFAULT NULL,
  deactivated_reason    TEXT NULL,
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_accounts_email (email),
  UNIQUE KEY uk_accounts_student_id (student_id),
  UNIQUE KEY uk_accounts_supabase_auth_uid (supabase_auth_uid),
  KEY idx_accounts_role_status (role, status),
  KEY idx_accounts_program_section (program, section),
  KEY idx_accounts_notification_enabled (notification_enabled),
  KEY idx_accounts_locked_until (locked_until),
  KEY idx_accounts_last_login_at (last_login_at),
  KEY idx_accounts_passkey_credential_id (passkey_credential_id),
  KEY idx_accounts_created_at (created_at),
  KEY idx_accounts_is_deactivated (is_deactivated)
);

-- ---- 2. AUTHORIZED STUDENTS ----------------------------------------
CREATE TABLE IF NOT EXISTS authorized_students (
  student_id  INT PRIMARY KEY,
  email       VARCHAR(255) NOT NULL,
  full_name   VARCHAR(255) NOT NULL,
  program     VARCHAR(64) NOT NULL,
  section     VARCHAR(32) NOT NULL,
  activated   TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uk_auth_students_email (email),
  KEY idx_auth_students_program_section_activated (program, section, activated),
  KEY idx_auth_students_activated (activated)
);

-- ---- 3. VERIFICATION TOKENS ---------------------------------------
CREATE TABLE IF NOT EXISTS verification_tokens (
  id          VARCHAR(128) PRIMARY KEY,
  account_id  VARCHAR(128) NOT NULL,
  code_hash   VARCHAR(255) NOT NULL,
  purpose     VARCHAR(64) NOT NULL,
  expires_at  TIMESTAMP NOT NULL,
  used_at     TIMESTAMP NULL DEFAULT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempts    INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_vt_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  KEY idx_vt_account_purpose_used (account_id, purpose, used_at),
  KEY idx_vt_expires_at (expires_at)
);

-- ---- 4. REFRESH TOKENS --------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          VARCHAR(128) PRIMARY KEY,
  account_id  VARCHAR(128) NOT NULL,
  token_hash  VARCHAR(255) NOT NULL,
  expires_at  TIMESTAMP NOT NULL,
  revoked_at  TIMESTAMP NULL DEFAULT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_rt_token_hash (token_hash),
  CONSTRAINT fk_rt_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  KEY idx_rt_account_revoked (account_id, revoked_at),
  KEY idx_rt_expires_at (expires_at)
);

-- ---- 5. EVENTS -----------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id                  INT PRIMARY KEY AUTO_INCREMENT,
  title               VARCHAR(255) NOT NULL,
  description         TEXT NULL,
  event_secret        VARCHAR(128) NOT NULL,
  owner_id            VARCHAR(128) NOT NULL,
  scope               VARCHAR(32) NOT NULL DEFAULT 'academic',
  target_program      VARCHAR(64) NULL DEFAULT NULL,
  target_section      VARCHAR(32) NULL DEFAULT NULL,
  scheduled_at        TIMESTAMP NOT NULL,
  ends_at             TIMESTAMP NULL DEFAULT NULL,
  check_in_opens_at   TIMESTAMP NULL DEFAULT NULL,
  check_in_closes_at  TIMESTAMP NULL DEFAULT NULL,
  time_out_opens_at   TIMESTAMP NULL DEFAULT NULL,
  time_out_closes_at  TIMESTAMP NULL DEFAULT NULL,
  enable_time_out     TINYINT(1) NOT NULL DEFAULT 0,
  delegatable         TINYINT(1) NOT NULL DEFAULT 1,
  delegation_enabled  TINYINT(1) NOT NULL DEFAULT 0,
  status              VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_events_owner FOREIGN KEY (owner_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  KEY idx_events_status_scheduled (status, scheduled_at),
  KEY idx_events_owner_status (owner_id, status),
  KEY idx_events_owner_status_scheduled (owner_id, status, scheduled_at),
  KEY idx_events_target_program_section_status (target_program, target_section, status),
  KEY idx_events_scheduled_status (scheduled_at, status)
);

-- ---- 6. EVENT ATTENDANCE (v8 anti-cheating fields) ----------------
CREATE TABLE IF NOT EXISTS event_attendance (
  id                      INT PRIMARY KEY AUTO_INCREMENT,
  event_id                INT NOT NULL,
  account_id              VARCHAR(128) NOT NULL,
  scanned_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  time_out_at             TIMESTAMP NULL DEFAULT NULL,
  source                  VARCHAR(32) NOT NULL DEFAULT 'qr',
  idempotency_key         VARCHAR(128) NULL DEFAULT NULL,
  token_block             INT NULL DEFAULT NULL,
  certificate_nonce       VARCHAR(128) NULL DEFAULT NULL,
  certificate_sub_frames  TEXT NULL,
  device_fingerprint      VARCHAR(128) NULL DEFAULT NULL,
  scanned_at_client       TIMESTAMP NULL DEFAULT NULL,
  UNIQUE KEY uk_attendance_event_account (event_id, account_id),
  UNIQUE KEY uk_attendance_idempotency_key (idempotency_key),
  UNIQUE KEY uk_attendance_certificate_nonce (certificate_nonce),
  CONSTRAINT fk_att_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  CONSTRAINT fk_att_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  KEY idx_att_account_scanned (account_id, scanned_at),
  KEY idx_att_event_scanned (event_id, scanned_at),
  KEY idx_att_scanned (scanned_at),
  KEY idx_att_device_fingerprint (device_fingerprint)
);

-- ---- 7. ATTENDANCE OVERRIDES --------------------------------------
CREATE TABLE IF NOT EXISTS attendance_overrides (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  event_id      INT NOT NULL,
  admin_id      VARCHAR(128) NOT NULL,
  student_id    INT NOT NULL,
  reason        TEXT NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_overrides_event_student (event_id, student_id),
  CONSTRAINT fk_ov_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  CONSTRAINT fk_ov_admin FOREIGN KEY (admin_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_ov_student FOREIGN KEY (student_id) REFERENCES authorized_students(student_id) ON DELETE CASCADE,
  KEY idx_ov_event_created (event_id, created_at),
  KEY idx_ov_admin_created (admin_id, created_at)
);

-- ---- 8. NOTIFICATIONS ---------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  account_id    VARCHAR(128) NOT NULL,
  title         VARCHAR(255) NOT NULL,
  body          TEXT NOT NULL,
  type          VARCHAR(64) NOT NULL DEFAULT 'info',
  read_at       TIMESTAMP NULL DEFAULT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notif_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  KEY idx_notif_account_created (account_id, created_at),
  KEY idx_notif_account_read (account_id, read_at),
  KEY idx_notif_read_created (read_at, created_at),
  KEY idx_notif_type_created (type, created_at)
);

-- ---- 9. AUDIT LOGS ------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  actor_id      VARCHAR(128) NULL DEFAULT NULL,
  action        VARCHAR(128) NOT NULL,
  target_type   VARCHAR(64) NULL DEFAULT NULL,
  target_id     VARCHAR(128) NULL DEFAULT NULL,
  metadata      TEXT NULL,
  ip_address    VARCHAR(45) NULL DEFAULT NULL,
  user_agent    VARCHAR(512) NULL DEFAULT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES accounts(id) ON DELETE SET NULL,
  KEY idx_audit_actor_created (actor_id, created_at),
  KEY idx_audit_action_created (action, created_at),
  KEY idx_audit_target (target_type, target_id, created_at),
  KEY idx_audit_created (created_at)
);

-- ---- 10. DEVICE KEYS ----------------------------------------------
CREATE TABLE IF NOT EXISTS device_keys (
  id              VARCHAR(128) PRIMARY KEY,
  account_id      VARCHAR(128) NOT NULL,
  public_key_jwk  TEXT NOT NULL,
  fingerprint     VARCHAR(128) NOT NULL,
  label           VARCHAR(255) NULL DEFAULT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at    TIMESTAMP NULL DEFAULT NULL,
  revoked_at      TIMESTAMP NULL DEFAULT NULL,
  UNIQUE KEY uk_device_keys_fingerprint (fingerprint),
  CONSTRAINT fk_dk_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  KEY idx_dk_account_revoked (account_id, revoked_at)
);

-- ---- 11. SETTINGS --------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  `key`       VARCHAR(128) PRIMARY KEY,
  `value`     TEXT NOT NULL,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---- 12. TERMS ACCEPTANCES ----------------------------------------
CREATE TABLE IF NOT EXISTS terms_acceptances (
  id              VARCHAR(128) PRIMARY KEY,
  account_id      VARCHAR(128) NOT NULL,
  terms_version   VARCHAR(32) NOT NULL,
  terms_hash      VARCHAR(255) NOT NULL,
  policy_version  VARCHAR(32) NOT NULL,
  policy_hash     VARCHAR(255) NOT NULL,
  ip_address      VARCHAR(45) NULL DEFAULT NULL,
  user_agent      VARCHAR(512) NULL DEFAULT NULL,
  accepted_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ta_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  KEY idx_ta_account_accepted (account_id, accepted_at)
);

-- ---- 13. VISITS (privacy-preserving analytics - no raw IP) --------
CREATE TABLE IF NOT EXISTS visits (
  id            VARCHAR(128) PRIMARY KEY,
  day_bucket    VARCHAR(10) NOT NULL,
  visitor_hash  VARCHAR(128) NOT NULL,
  route         VARCHAR(255) NOT NULL,
  country       VARCHAR(8) NULL DEFAULT NULL,
  visits        INT NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_visits_day_visitor_route (day_bucket, visitor_hash, route),
  KEY idx_visits_day_bucket (day_bucket),
  KEY idx_visits_route (route)
);

-- End of TiDB schema (v16 - mirrors prisma/schema.tidb.prisma)
