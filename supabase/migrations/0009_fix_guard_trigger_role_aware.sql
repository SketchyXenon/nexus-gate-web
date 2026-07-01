-- ====================================================================
-- Nexus Gate — 0009_fix_guard_trigger_role_aware.sql
-- --------------------------------------------------------------------
-- Fixes a critical bug in migration 0005's guard_account_columns()
-- trigger that blocked ALL updates to sensitive account columns —
-- including legitimate updates from the Next.js backend (Prisma).
--
-- THE BUG:
--   Migration 0005 created a BEFORE UPDATE trigger that raises an
--   exception whenever status/role/student_id/failed_login_attempts/
--   locked_until/password_hash changes. Its comment claimed "the
--   service role bypasses RLS, so app writes are unaffected" — but
--   that is FALSE. RLS controls row VISIBILITY; triggers fire on ALL
--   writes regardless of the caller's role. So the trigger blocked
--   Prisma's legitimate updates too.
--
-- SYMPTOMS THIS FIXES:
--   * POST /api/auth/login → 503 (could not flip PENDING_VERIFICATION
--     → ACTIVE, could not increment failedLoginAttempts)
--   * POST /api/auth/change-password → blocked (password_hash)
--   * POST /api/auth/reset-password → blocked (password_hash)
--   * PATCH /api/accounts/[id] (admin) → blocked (role, status)
--   * Registration worked because it uses INSERT (trigger is UPDATE only)
--
-- THE FIX:
--   Make the trigger role-aware. Supabase's PostgREST connects as the
--   `authenticator` role and issues `SET ROLE authenticated` (or `anon`)
--   for each REST API request — so current_setting('role') returns
--   'authenticated'/'anon' during REST API writes. Direct Prisma
--   connections (user `postgres` / `postgres.<ref>`) never issue SET
--   ROLE, so current_setting('role', true) returns NULL.
--
--   The guard now ONLY enforces for authenticated/anon (REST API context).
--   Trusted backend connections (NULL role, or service_role) skip the
--   guard — exactly what migration 0005 INTENDED but failed to implement.
--
--   This preserves the defense-in-depth goal: if someone later adds an
--   RLS policy allowing own-row updates via REST, this trigger still
--   blocks self-escalation of role/status via the REST API.
-- ====================================================================

CREATE OR REPLACE FUNCTION guard_account_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_role text;
BEGIN
  -- Determine the active role. PostgREST sets this to 'authenticated' or
  -- 'anon' for REST API requests. Direct backend connections (Prisma via
  -- postgres / postgres.<ref>) leave it NULL. The service_role also has
  -- it NULL or 'service_role'.
  v_role := current_setting('role', true);

  -- ONLY enforce the guard for REST API users (authenticated/anon).
  -- Trusted backend connections (NULL role, service_role, postgres
  -- superuser) skip the guard — they come from the Next.js API routes,
  -- which have their own RBAC layer.
  IF v_role IS NULL OR v_role NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- Block changes to sensitive columns via the REST API (RLS context).
  -- These columns must only be changed through the Next.js admin/password
  -- API routes, which connect as the trusted backend.
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'role column cannot be changed via RLS — use the admin API';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'status column cannot be changed via RLS — use the admin API';
  END IF;
  IF NEW.student_id IS DISTINCT FROM OLD.student_id THEN
    RAISE EXCEPTION 'student_id column cannot be changed via RLS — use the admin API';
  END IF;
  IF NEW.failed_login_attempts IS DISTINCT FROM OLD.failed_login_attempts THEN
    RAISE EXCEPTION 'failed_login_attempts cannot be changed via RLS';
  END IF;
  IF NEW.locked_until IS DISTINCT FROM OLD.locked_until THEN
    RAISE EXCEPTION 'locked_until cannot be changed via RLS';
  END IF;
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
    RAISE EXCEPTION 'password_hash cannot be changed via RLS — use the password API';
  END IF;
  RETURN NEW;
END;
$$;

-- The trigger itself doesn't need to be recreated — CREATE OR REPLACE
-- FUNCTION updates the function body in place, and the existing trigger
-- (trg_guard_account_columns) will use the new definition immediately.

-- ====================================================================
-- VERIFICATION (run manually in Supabase SQL Editor to confirm):
--
--   1. Confirm the function is updated:
--      SELECT prosrc FROM pg_proc WHERE proname = 'guard_account_columns';
--      -- Should contain "v_role := current_setting('role', true);"
--
--   2. Confirm the trigger is still attached:
--      SELECT tgname FROM pg_trigger
--      WHERE tgrelid = 'accounts'::regclass AND NOT tgisinternal;
--      -- Should show: trg_guard_account_columns
--
--   3. Test a backend-style update (should succeed):
--      -- As the postgres user (via Prisma / direct connection):
--      UPDATE accounts SET status = status WHERE email = 'admin@ctu.edu.ph';
--      -- Should affect 1 row with no error.
-- ====================================================================

-- End of migration 0009_fix_guard_trigger_role_aware.sql
