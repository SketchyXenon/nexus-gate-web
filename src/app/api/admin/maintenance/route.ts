import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  badRequest,
  parseBody,
  requireAuth,
  invalidateMaintenanceCache,
} from "@/lib/api";
import { audit } from "@/lib/audit";

// ====================================================================
// POST /api/admin/maintenance  (ADMIN only)
//
// Toggles maintenance mode. When ON, non-admin users are blocked at
// the requireAuth() guard (see src/lib/api.ts → isMaintenanceMode()).
// Admins always bypass the check so they can still manage the system.
//
// Body: { enabled: boolean, message?: string }
//
// Persists two Setting rows:
//  - maintenance_mode   = "true" | "false"
//  - maintenance_message = the custom notice (only when provided)
//
// Returns the new state so the UI can update immediately.
// ====================================================================

const maintenanceSchema = z.object({
  enabled: z.boolean(),
  message: z.string().trim().max(500).optional(),
});

export async function POST(req: NextRequest) {
  const res = await requireAuth("ADMIN");
  if ("error" in res) return res.error;
  const { account } = res;

  const body = await parseBody(req);
  const parsed = maintenanceSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const { enabled, message } = parsed.data;

  // Per 02-system-design.md §5 "Scalability": the two Setting rows
  // (maintenance_mode + maintenance_message) are independent (different
  // keys) — run them in parallel to save 1 DB round-trip per toggle.
  let finalMessage: string | null;
  if (message !== undefined) {
    await Promise.all([
      db.setting.upsert({
        where: { key: "maintenance_mode" },
        create: { key: "maintenance_mode", value: enabled ? "true" : "false" },
        update: { value: enabled ? "true" : "false" },
      }),
      db.setting.upsert({
        where: { key: "maintenance_message" },
        create: { key: "maintenance_message", value: message },
        update: { value: message },
      }),
    ]);
    finalMessage = message;
  } else {
    const [, existing] = await Promise.all([
      db.setting.upsert({
        where: { key: "maintenance_mode" },
        create: { key: "maintenance_mode", value: enabled ? "true" : "false" },
        update: { value: enabled ? "true" : "false" },
      }),
      db.setting.findUnique({ where: { key: "maintenance_message" } }),
    ]);
    finalMessage = existing?.value ?? null;
  }

  // L1 fix: invalidate the maintenance cache so the toggle takes effect
  // immediately (was up to 10s stale). Must come AFTER the DB write commits.
  invalidateMaintenanceCache();

  await audit({
    actorId: account.id,
    action: "admin.maintenance_toggle",
    targetType: "Setting",
    targetId: "maintenance_mode",
    metadata: { enabled, messageProvided: message !== undefined },
    req,
  });

  return NextResponse.json({
    ok: true,
    maintenanceMode: enabled,
    message: finalMessage,
  });
}
