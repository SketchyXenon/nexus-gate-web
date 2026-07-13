-- ====================================================================
-- Nexus Gate — 0014_invalidate_seed_admin_hash.sql
-- --------------------------------------------------------------------
-- Migration 0001 committed a bcrypt hash for the seed admin
-- (admin@ctu.edu.ph, password "nexus123") directly in the migration
-- file. That hash is in git history forever — anyone with repo access
-- can crack it offline. This migration forces a password reset on any
-- account whose password_hash still matches the committed hash, by
-- setting password_hash to NULL and status to SUSPENDED. The account
-- must then be re-bootstrapped via scripts/bootstrap-admin.ts or the
-- forgot-password flow.
--
-- Operators who have already changed the seed admin's password are
-- unaffected (their hash won't match).
-- ====================================================================

-- The exact bcrypt hash committed in migration 0001_init.sql.
DO $$
BEGIN
    UPDATE accounts
    SET password_hash = NULL,
        status = 'SUSPENDED'
    WHERE password_hash = '$2b$12$TyKoZ7xca222PRGY/Ni8teAqrJRTWvEcZnMfAVmRbS.P4o7BTUaNS';

    IF FOUND THEN
        RAISE NOTICE 'Seed admin password invalidated (%) rows. Re-bootstrap via scripts/bootstrap-admin.ts.', FOUND;
    ELSE
        RAISE NOTICE 'No account matched the seed admin hash — already changed. No action taken.';
    END IF;
END $$;

-- End of migration 0014_invalidate_seed_admin_hash.sql
