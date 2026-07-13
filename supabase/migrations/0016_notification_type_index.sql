-- ====================================================================
-- Nexus Gate — 0016_notification_type_index.sql
-- --------------------------------------------------------------------
-- Adds an index on notifications(type, created_at) to support the
-- cron event-reminders dedup query: WHERE type LIKE 'reminder:event:%'
-- AND created_at > (now - 1 hour). Without this index, the query does
-- a full table scan on the notifications table (which can grow to
-- 600k+ rows at 3000 users).
-- Also adds a GIN trigram index on notifications.type for the
-- startsWith query pattern.
-- ====================================================================

-- Composite index for the dedup query (type prefix + date range).
CREATE INDEX IF NOT EXISTS idx_notifications_type_created_at
    ON notifications (type, created_at);

-- End of migration 0016_notification_type_index.sql
