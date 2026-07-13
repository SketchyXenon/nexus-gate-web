// Allow up to 10s for the DB write.
export const maxDuration = 10;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, badRequest } from "@/lib/api";
import { audit } from "@/lib/audit";
import { z } from "zod";

// GET /api/profile/notification-prefs
// Returns the user's notification preferences.
// PATCH /api/profile/notification-prefs
// Updates the user's notification preferences.
//
// Preferences are stored as a JSON object:
//   { eventReminders: boolean, attendanceSummary: boolean, accountSecurity: boolean }
// Defaults: all true (backward compatible).

const prefsSchema = z.object({
  eventReminders: z.boolean(),
  attendanceSummary: z.boolean(),
  accountSecurity: z.boolean(),
});

type Prefs = z.infer<typeof prefsSchema>;

const DEFAULT_PREFS: Prefs = {
  eventReminders: true,
  attendanceSummary: true,
  accountSecurity: true,
};

// Parse the stored JSON (handles both Postgres Json and SQLite string).
function parsePrefs(raw: unknown): Prefs {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_PREFS, ...parsed };
    } catch {
      return DEFAULT_PREFS;
    }
  }
  if (raw && typeof raw === "object") {
    return { ...DEFAULT_PREFS, ...(raw as Record<string, unknown>) } as Prefs;
  }
  return DEFAULT_PREFS;
}

export async function GET(_req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  const row = await db.account.findUnique({
    where: { id: account.id },
    select: { notificationPrefs: true },
  });

  const prefs = parsePrefs(row?.notificationPrefs);
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

  // Store the preferences. The Postgres schema declares notificationPrefs
  // as Json? (accepts an object); SQLite declares it as String? (accepts
  // a string). We store the object for Postgres and a JSON string for
  // SQLite. The `as never` cast bridges the type gap between the two
  // generated Prisma clients (the dev client is generated from the SQLite
  // schema, the prod client from the Postgres schema).
  const isPostgres = process.env.DATABASE_URL?.startsWith("postgresql");
  const stored = isPostgres
    ? (parsed.data as never)
    : (JSON.stringify(parsed.data) as never);

  await db.account.update({
    where: { id: account.id },
    data: { notificationPrefs: stored },
  });

  await audit({
    actorId: account.id,
    action: "profile.notification_prefs_updated",
    targetType: "Account",
    targetId: account.id,
    metadata: parsed.data,
    req,
  }).catch(() => {});

  return NextResponse.json({ ok: true, prefs: parsed.data });
}
