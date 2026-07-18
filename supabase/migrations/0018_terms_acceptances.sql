-- ====================================================================
-- Nexus Gate - 0018_terms_acceptances.sql
-- --------------------------------------------------------------------
-- Immutable append-only table recording every Terms of Service and
-- Privacy Policy acceptance. Rows are never updated or deleted (legal
-- compliance audit trail). If the Terms change, a new row is inserted
-- with the updated version + hash.
--
-- Columns:
--   id              - cuid primary key
--   account_id      - FK to accounts.id (cascade on delete)
--   terms_version   - semantic version of the Terms document
--   terms_hash      - SHA-256 hash of the Terms content at acceptance
--   policy_version  - semantic version of the Privacy Policy
--   policy_hash     - SHA-256 hash of the Policy content
--   ip_address      - client IP for legal evidence
--   user_agent      - client user agent for legal evidence
--   accepted_at     - timestamp of acceptance
--
-- Index on (account_id, accepted_at) for compliance audit queries.
-- ====================================================================

CREATE TABLE IF NOT EXISTS terms_acceptances (
    id              TEXT PRIMARY KEY,
    account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    terms_version   TEXT NOT NULL,
    terms_hash      TEXT NOT NULL,
    policy_version  TEXT NOT NULL,
    policy_hash     TEXT NOT NULL,
    ip_address      TEXT,
    user_agent      TEXT,
    accepted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_terms_acceptances_account_accepted
    ON terms_acceptances (account_id, accepted_at);

-- End of migration 0018_terms_acceptances.sql
