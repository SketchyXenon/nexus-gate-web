// Shared notification preferences helpers.
// Used by the register/create-account routes (to seed defaults) and the
// profile/notification-prefs route (to read/write). Centralizing here keeps
// the default object + parser in one place (DRY) and ensures every account
// is created with the same defaults regardless of DB backend.
//
// On Postgres the `notification_prefs` column had a DB-level default
// ('{"eventReminders":true,...}'::jsonb, migration 0015). On TiDB/MySQL the
// column is nullable with no DB default, so the app MUST seed it explicitly
// on account creation. On SQLite (dev) the column is a String? and stores a
// JSON string. This module handles all three.

import { storesJsonAsString } from "@/lib/db-provider";

export interface NotificationPrefs {
  eventReminders: boolean;
  attendanceSummary: boolean;
  accountSecurity: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  eventReminders: true,
  attendanceSummary: true,
  accountSecurity: true,
};

// Parse the stored JSON value into a Prefs object. Handles:
//   - object (Postgres Json / TiDB Json - Prisma returns parsed object)
//   - string (SQLite String? - stores JSON string; also legacy Postgres rows)
//   - null/undefined (returns defaults - for rows created before the column
//     existed, or TiDB rows where the app didn't seed the default)
export function parseNotificationPrefs(raw: unknown): NotificationPrefs {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_NOTIFICATION_PREFS, ...parsed };
    } catch {
      return DEFAULT_NOTIFICATION_PREFS;
    }
  }
  if (raw && typeof raw === "object") {
    return {
      ...DEFAULT_NOTIFICATION_PREFS,
      ...(raw as Record<string, unknown>),
    } as NotificationPrefs;
  }
  return DEFAULT_NOTIFICATION_PREFS;
}

// Serialize a Prefs object for storage. On SQLite (String? column) it must be
// a JSON string; on Postgres/TiDB (Json? column) Prisma accepts the object.
// The `as never` cast bridges the type gap between generated clients.
export function serializeNotificationPrefs(
  prefs: NotificationPrefs,
): unknown {
  return storesJsonAsString()
    ? (JSON.stringify(prefs) as never)
    : (prefs as never);
}
