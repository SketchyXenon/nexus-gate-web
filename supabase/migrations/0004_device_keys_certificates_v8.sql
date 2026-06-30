-- ====================================================================
-- Nexus Gate — 0004_device_keys_certificates_v8.sql
-- --------------------------------------------------------------------
-- Migration 0004 — adds device key registration and scan certificate
-- fields for the Tier 1 + Tier 2 anti-cheating system.
--
-- What this migration does:
--   1. Creates the `device_keys` table (Ed25519 public keys per account).
--   2. Adds certificate fields to `event_attendance`:
--        certificate_nonce     UNIQUE  — one-time-use, atomic dedup
--        certificate_sub_frames        — JSON array of sub-frame indices
--        device_fingerprint            — SHA-256 of the device public key
--        scanned_at_client             — client-reported scan timestamp
--   3. Adds indexes for the new fields.
--   4. Enables RLS on `device_keys` (own-row-only for authenticated users).
--
-- Idempotent: every statement is guarded with IF [NOT] EXISTS.
-- ====================================================================


-- ====================================================================
-- 1. DEVICE KEYS TABLE
-- ====================================================================
CREATE TABLE IF NOT EXISTS device_keys (
    id              TEXT        PRIMARY KEY,
    account_id      TEXT        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    public_key_jwk  TEXT        NOT NULL,   -- Ed25519 public key as JSON Web Key
    fingerprint     TEXT        NOT NULL UNIQUE, -- SHA-256 hash of the public key
    label           TEXT,                    -- optional device name
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ
);

-- Composite: "list this account's active devices"
CREATE INDEX IF NOT EXISTS idx_device_keys_account_revoked
    ON device_keys (account_id, revoked_at);
-- fingerprint is already UNIQUE (no separate index needed)


-- ====================================================================
-- 2. CERTIFICATE FIELDS ON EVENT_ATTENDANCE
-- ====================================================================
ALTER TABLE event_attendance
    ADD COLUMN IF NOT EXISTS certificate_nonce TEXT UNIQUE;
ALTER TABLE event_attendance
    ADD COLUMN IF NOT EXISTS certificate_sub_frames TEXT; -- JSON array
ALTER TABLE event_attendance
    ADD COLUMN IF NOT EXISTS device_fingerprint TEXT;
ALTER TABLE event_attendance
    ADD COLUMN IF NOT EXISTS scanned_at_client TIMESTAMPTZ;

-- Index for device audit: "list all scans from this device"
CREATE INDEX IF NOT EXISTS idx_event_attendance_device_fingerprint
    ON event_attendance (device_fingerprint);


-- ====================================================================
-- 3. RLS ON DEVICE_KEYS
-- --------------------------------------------------------------------
-- A user can read only their own device keys. All writes (register,
-- revoke) go through the service role (server-side API routes).
-- ====================================================================
ALTER TABLE device_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS device_keys_select_own ON device_keys;
CREATE POLICY device_keys_select_own
    ON device_keys FOR SELECT
    TO authenticated
    USING (account_id = auth.uid()::text);


-- ====================================================================
-- 4. ATOMIC updated_at TRIGGER (device_keys inherits the global
--    set_updated_at() function from migration 0003)
-- ====================================================================
-- Note: device_keys does NOT have an updated_at column (immutable after
-- creation except for last_used_at and revoked_at, which are set
-- explicitly by the API). No trigger needed.


-- End of migration 0004_device_keys_certificates_v8.sql
