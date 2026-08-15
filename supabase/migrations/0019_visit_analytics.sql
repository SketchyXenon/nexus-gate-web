-- ====================================================================
-- Nexus Gate - 0019_visit_analytics.sql
-- --------------------------------------------------------------------
-- Privacy-preserving visit analytics. NO raw IP address is ever stored.
--
-- The application HMAC-SHA256-hashes the public IP with a daily-rotating
-- server secret (derived from AUTH_SECRET) before writing visitor_hash.
-- This means:
--   - visitor_hash is non-reversible (cannot recover the IP).
--   - The same IP produces a DIFFERENT visitor_hash each day, so cross-day
--     correlation is impossible without the secret.
--   - The hash identifies "same visitor on the same day" only — sufficient
--     for unique-visitor counts, nothing more.
--
-- Per 06-security-architecture.md §8 (data minimization) and §11 (never
-- log full PII).
--
-- Columns:
--   id            - cuid primary key
--   day_bucket    - YYYY-MM-DD (UTC) — daily rotation boundary
--   visitor_hash  - HMAC(secret, public_ip) — non-reversible, 32 hex chars
--   route         - path visited (e.g. "/" or "/api/events")
--   country       - optional, country-level only (CF-IPCountry)
--   visits        - upserted counter
--   first_seen_at - first visit for this (day, visitor, route) trio
--   last_seen_at  - most recent visit (updated on each upsert)
--
-- Unique constraint on (day_bucket, visitor_hash, route) enables
-- aggregated upserts — the row count stays bounded by unique visitor
-- count per day, not by total page views.
--
-- Indexes:
--   - (day_bucket) for the 7-day dashboard range query.
--   - (route) for the top-routes query.
-- ====================================================================

CREATE TABLE IF NOT EXISTS visits (
    id            TEXT PRIMARY KEY,
    day_bucket    TEXT NOT NULL,
    visitor_hash  TEXT NOT NULL,
    route         TEXT NOT NULL,
    country       TEXT,
    visits        INTEGER NOT NULL DEFAULT 1,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Aggregated upsert dedup: one row per (day, visitor, route).
CREATE UNIQUE INDEX IF NOT EXISTS visits_day_visitor_route_key
    ON visits (day_bucket, visitor_hash, route);

-- 7-day dashboard range query.
CREATE INDEX IF NOT EXISTS idx_visits_day_bucket
    ON visits (day_bucket);

-- Top-routes query.
CREATE INDEX IF NOT EXISTS idx_visits_route
    ON visits (route);

-- End of migration 0019_visit_analytics.sql
