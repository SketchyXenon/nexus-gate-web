-- ====================================================================
-- Nexus Gate — 0006_delegation_enabled_v10.sql
-- --------------------------------------------------------------------
-- Migration 0006 — adds the `delegation_enabled` column to the events
-- table for the new QR delegation feature.
--
-- QR Delegation Rules (v10):
--   - delegation_enabled is FALSE by default (no delegation)
--   - Admin sets it to TRUE to allow other organizers to project
--   - Other organizers can project IF:
--     a. delegation_enabled is TRUE, AND
--     b. EITHER the event is open-to-all (both target_program AND
--        target_section are NULL), OR
--     c. The organizer shares the same organization_name tag as the
--        event owner (both must be set and non-empty)
--   - If organization_name is not set on either party AND the event
--     is not open-to-all, delegation is blocked.
-- ====================================================================

-- Add the delegation_enabled column to events
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS delegation_enabled BOOLEAN NOT NULL DEFAULT false;

-- Add a CHECK constraint to ensure delegation_enabled is a proper boolean
-- (already enforced by the BOOLEAN type, but explicit for documentation)
-- No additional constraint needed.

-- The existing `delegatable` column is kept for backward compatibility
-- but is effectively superseded by `delegation_enabled`. The application
-- checks `delegation_enabled` for the new delegation logic.

-- End of migration 0006_delegation_enabled_v10.sql
