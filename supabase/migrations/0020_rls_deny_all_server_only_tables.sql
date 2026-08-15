-- ====================================================================
-- Nexus Gate - 0020_rls_deny_all_server_only_tables.sql
-- --------------------------------------------------------------------
-- Fixes Supabase Database Linter finding `rls_enabled_no_policy` on:
--   - terms_acceptances (migration 0018)
--   - visits (migration 0019)
--
-- Both tables are SERVER-ONLY: they are accessed exclusively via the
-- Next.js backend using the Supabase service role key, which bypasses
-- RLS. Supabase auto-enabled RLS on table creation (default dashboard
-- behavior), but no policies were created, so the linter flagged the
-- ambiguity ("did the dev forget, or is it intentional?").
--
-- Per 06-security-architecture.md section 1 (defense in depth): keep
-- RLS enabled as a layer. The service role bypasses it, so the app
-- works; but if the service role key ever leaks, anon/authenticated
-- roles still get nothing from these tables.
--
-- The explicit deny-all policy documents the intent: NO direct client
-- access by design. This satisfies the linter (a policy exists) and
-- makes the security posture explicit.
-- ====================================================================

-- ---- terms_acceptances ----
ALTER TABLE terms_acceptances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS terms_acceptances_deny_all ON terms_acceptances;
CREATE POLICY terms_acceptances_deny_all
    ON terms_acceptances
    FOR ALL
    TO anon, authenticated
    USING (false)
    WITH CHECK (false);

-- ---- visits ----
ALTER TABLE visits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS visits_deny_all ON visits;
CREATE POLICY visits_deny_all
    ON visits
    FOR ALL
    TO anon, authenticated
    USING (false)
    WITH CHECK (false);

-- End of migration 0020_rls_deny_all_server_only_tables.sql
