import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { badRequest, parseBody, requireAuth } from "@/lib/api";
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
//   - maintenance_mode   = "true" | "false"
//   - maintenance_message = the custom notice (only when provided)
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
    return badRequest(
      parsed.error.issues[0]?.message ?? "Invalid input"
    );
  }
  const { enabled, message } = parsed.data;

  // Upsert the maintenance_mode flag. SQLite doesn't have a native
  // upsert helper for the String-id Setting table, so we use the
  // Prisma upsert primitive on the key.
  await db.setting.upsert({
    where: { key: "maintenance_mode" },
    create: { key: "maintenance_mode", value: enabled ? "true" : "false" },
    update: { value: enabled ? "true" : "false" },
  });

  // Only persist a message if one was provided. We don't clear an
  // existing message when disabling — the admin may toggle back on
  // and want the same notice reused.
  let finalMessage: string | null = null;
  if (message !== undefined) {
    await db.setting.upsert({
      where: { key: "maintenance_message" },
      create: { key: "maintenance_message", value: message },
      update: { value: message },
    });
    finalMessage = message;
  } else {
    const existing = await db.setting.findUnique({
      where: { key: "maintenance_message" },
    });
    finalMessage = existing?.value ?? null;
  }

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
