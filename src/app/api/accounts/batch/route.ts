import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { badRequest, forbidden, parseBody, requireAuth } from "@/lib/api";
import { audit } from "@/lib/audit";
import { invalidateAccountCache } from "@/lib/supabase-session";

// Allow up to 15s for large batches.
export const maxDuration = 15;

// ====================================================================
// POST /api/accounts/batch (ADMIN)
// --------------------------------------------------------------------
// Applies a single status/role change to many accounts at once, so admins
// don't have to edit each account individually.
//
// SAFETY MEASURES (per Z.md "careful actions" + 06-security §3 POLP):
//   1. Hard cap of 200 ids per call (prevents accidental mass-wipe).
//   2. HARD DELETE is NEVER supported here - only status/role changes.
//      Use the single-account DELETE ?hard=true route (ADMIN-only, audited
//      individually) for permanent removal.
//   3. Last-admin guard: refuses to demote/suspend if it would leave the
//      system with zero active admins.
//   4. Self-action guard: an admin cannot change their own role/status
//      via the batch endpoint (prevents self-lockout at scale).
//   5. Email/fullName/program/section changes are NOT supported in batch -
//      those are identity changes that should be reviewed one-by-one.
//      Batch only supports status (activate/suspend) and role assignments.
//   6. Every batch is audited with the full id list + action.
// ====================================================================

const batchSchema = z
  .object({
    ids: z
      .array(z.string().min(1))
      .min(1, "Select at least one account")
      .max(200, "Batch is limited to 200 accounts at a time"),
    action: z.enum(["activate", "suspend", "setRole"]),
    role: z.enum(["ADMIN", "ORGANIZER", "USER"]).optional(),
  })
  .refine((d) => d.action !== "setRole" || !!d.role, {
    message: "A role is required for the setRole action",
    path: ["role"],
  });

export async function POST(req: NextRequest) {
  const res = await requireAuth("ADMIN");
  if ("error" in res) return res.error;
  const { account: admin } = res;

  const body = await parseBody(req);
  const parsed = batchSchema.safeParse(body);
  if (!parsed.success)
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  const { ids, action, role } = parsed.data;

  // Self-action guard: never let an admin batch-change their own account.
  if (ids.includes(admin.id)) {
    return forbidden(
      "You cannot include your own account in a batch operation. Remove yourself from the selection to continue.",
    );
  }

  // Fetch the targets (existence + current state for the guards).
  const targets = await db.account.findMany({
    where: { id: { in: ids } },
    select: { id: true, role: true, status: true, supabaseAuthUid: true },
  });
  if (targets.length === 0) return badRequest("No matching accounts found");

  const targetIds = targets.map((t) => t.id);

  // ---- Last-admin guard ----
  // If the batch would demote or suspend any ADMIN, ensure at least one other
  // active admin remains (outside the target set).
  const touchesAdmin = targets.some((t) => t.role === "ADMIN");
  if (
    touchesAdmin &&
    (action === "suspend" || (action === "setRole" && role !== "ADMIN"))
  ) {
    const activeAdminsOutsideBatch = await db.account.count({
      where: {
        role: "ADMIN",
        status: "ACTIVE",
        id: { notIn: targetIds },
      },
    });
    if (activeAdminsOutsideBatch < 1) {
      return forbidden(
        "This batch would leave the system with no active administrators. Keep at least one admin outside the selection, or promote another account to admin first.",
      );
    }
  }

  // ---- Build the update payload ----
  // Note: the zod refine guarantees `role` is set when action === "setRole",
  // but TypeScript can't narrow the type through a refine. The explicit
  // check below is defense-in-depth (fail closed if the invariant breaks).
  let data: Record<string, unknown>;
  let actionLabel: string;
  if (action === "activate") {
    data = { status: "ACTIVE" };
    actionLabel = "batch.activate";
  } else if (action === "suspend") {
    data = { status: "SUSPENDED" };
    actionLabel = "batch.suspend";
  } else {
    if (!role) return badRequest("A role is required for the setRole action");
    data = { role };
    actionLabel = "batch.set_role";
  }

  const result = await db.account.updateMany({
    where: { id: { in: targetIds } },
    data,
  });

  // Revoke sessions + invalidate cache for every touched account so the
  // change takes effect immediately (not when their token expires).
  const authUids = targets
    .map((t) => t.supabaseAuthUid)
    .filter((u): u is string => !!u);
  await db.refreshToken
    .updateMany({
      where: { accountId: { in: targetIds }, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    .catch(() => {
      // Non-fatal: the status/role change still applies on next session refresh.
    });
  for (const uid of authUids) invalidateAccountCache(uid);

  await audit({
    actorId: admin.id,
    action: actionLabel,
    targetType: "Account",
    targetId: targetIds.join(",").slice(0, 200),
    metadata: {
      count: result.count,
      ids: targetIds,
      action,
      ...(action === "setRole" ? { role } : {}),
    },
    req,
  });

  return NextResponse.json({
    ok: true,
    updated: result.count,
    action,
  });
}

// NOTE: There is intentionally NO DELETE method on this route. Bulk hard-
// delete of accounts is too dangerous to expose as a single call - the
// existing single-account DELETE ?hard=true route (ADMIN-only, audited
// individually) remains the only path to permanent removal. This is a
// deliberate safety decision: an accidental bulk delete cannot wipe the
// account table, even by a compromised admin token.
