-- Nexus Gate - 0008_passkey_credential_field.sql
-- Adds a dedicated passkey_credential column to accounts table.
-- Previously passkey credentials were stored in notification_keys,
-- which collided with push notification subscription data.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS passkey_credential TEXT;
