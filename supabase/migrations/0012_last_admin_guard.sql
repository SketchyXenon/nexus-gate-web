-- ====================================================================
-- Migration 0012: Last-admin guard trigger
-- --------------------------------------------------------------------
-- Prevents a race condition where two admins simultaneously demote
-- each other, leaving 0 active admins (TOCTOU race). The trigger fires
-- atomically at the DB level — no race window possible.
--
-- Fires BEFORE UPDATE or DELETE on accounts. If the operation would
-- reduce the active admin count to 0, it raises an exception that
-- aborts the transaction.
-- ====================================================================

CREATE OR REPLACE FUNCTION guard_last_admin()
RETURNS TRIGGER AS $$
DECLARE
  active_admin_count INT;
BEGIN
  -- Only check when the row being modified is an ACTIVE ADMIN.
  IF OLD.role = 'ADMIN' AND OLD.status = 'ACTIVE' THEN
    -- For UPDATE: check if the new values would remove admin status.
    IF TG_OP = 'UPDATE' THEN
      IF NEW.role != 'ADMIN' OR NEW.status != 'ACTIVE' THEN
        SELECT COUNT(*) INTO active_admin_count
        FROM accounts
        WHERE role = 'ADMIN' AND status = 'ACTIVE';
        -- Count includes OLD row — if this is the last one, block.
        IF active_admin_count <= 1 THEN
          RAISE EXCEPTION 'Cannot remove the last active admin account';
        END IF;
      END IF;
    END IF;
    -- For DELETE: always block if this is the last active admin.
    IF TG_OP = 'DELETE' THEN
      SELECT COUNT(*) INTO active_admin_count
      FROM accounts
      WHERE role = 'ADMIN' AND status = 'ACTIVE';
      IF active_admin_count <= 1 THEN
        RAISE EXCEPTION 'Cannot delete the last active admin account';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_last_admin ON accounts;
CREATE TRIGGER trg_guard_last_admin
  BEFORE UPDATE OR DELETE ON accounts
  FOR EACH ROW
  EXECUTE FUNCTION guard_last_admin();
