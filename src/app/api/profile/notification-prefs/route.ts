// Allow up to 10s for the DB write.
export const maxDuration = 10;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, badRequest } from "@/lib/api";
import { audit } from "@/lib/audit";
import { z } from "zod";
import {
  parseNotificationPrefs,
  serializeNotificationPrefs,
  type NotificationPrefs,
} from "@/lib/notification-prefs";

// GET /api/profile/notification-prefs
// Returns the user's notification preferences.
// PATCH /api/profile/notification-prefs
// Updates the user's notification preferences.
//
// Preferences are stored as a JSON object:
//   { eventReminders: boolean, attendanceSummary: boolean, accountSecurity: boolean }
// Defaults: all true (backward compatible). Seeded on account creation by
// the register/create routes (see src/lib/notification-prefs.ts).

const prefsSchema = z.object({
  eventReminders: z.boolean(),
  attendanceSummary: z.boolean(),
  accountSecurity: z.boolean(),
});

export async function GET(_req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  const row = await db.account.findUnique({
    where: { id: account.id },
    select: { notificationPrefs: true },
  });

  const prefs: NotificationPrefs = parseNotificationPrefs(
    row?.notificationPrefs,
  );
  return NextResponse.json(
    { prefs },
    { headers: { "Cache-Control": "private, no-cache" } },
  );
}

export async function PATCH(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  const body = await req.json().catch(() => null);
  const parsed = prefsSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid preferences");
  }

  // Serialize via the shared helper so storage is correct across SQLite
  // (String? column -> JSON string) and Postgres/TiDB (Json? -> object).
  await db.account.update({
    where: { id: account.id },
    data: {
      notificationPrefs: serializeNotificationPrefs(parsed.data) as never,
    },
  });

  // M5 fix: previously .catch(() => {}) silently swallowed audit failures,
  // so operators had no visibility when the audit pipeline broke. Now logs
  // a warning on failure (the audit() helper is fire-and-forget by design,
  // but a failure should at least surface in server logs).
  await audit({
    actorId: account.id,
    action: "profile.notification_prefs_updated",
    targetType: "Account",
    targetId: account.id,
    metadata: parsed.data,
    req,
  }).catch((e) => {
    console.warn(
      "[notification-prefs] audit log failed (non-critical):",
      e instanceof Error ? e.message : e,
    );
  });

  return NextResponse.json({ ok: true, prefs: parsed.data });
}
