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

  // ---- Build the update payload ----
  // Note: the zod refine guarantees `role` is set when action === "setRole",
  // but TypeScript can't narrow the type through a refine. The explicit
  // check below is defense-in-depth (fail closed if the invariant breaks).
  let data: Record<string, unknown>;
  let actionLabel: string;
  let demotes: boolean; // true if this batch would demote/suspend an ADMIN
  if (action === "activate") {
    data = { status: "ACTIVE" };
    actionLabel = "batch.activate";
    demotes = false; // activating never removes an admin
  } else if (action === "suspend") {
    data = { status: "SUSPENDED" };
    actionLabel = "batch.suspend";
    demotes = targets.some((t) => t.role === "ADMIN" && t.status === "ACTIVE");
  } else {
    if (!role) return badRequest("A role is required for the setRole action");
    data = { role };
    actionLabel = "batch.set_role";
    demotes =
      role !== "ADMIN" &&
      targets.some((t) => t.role === "ADMIN" && t.status === "ACTIVE");
  }

  // ---- Last-admin guard + batch update (TOCTOU-safe via transaction) ----
  // Pre-check (fast-path reject) + in-txn re-verification:
  //   1. Re-fetch the targets' current role/status inside the txn.
  //   2. Re-count active admins OUTSIDE the still-admin target set; if <1,
  //      forbidden (mirrors the original guard, but on fresh state).
  //   3. updateMany with `where: { id: { in }, role: "ADMIN", status: "ACTIVE" }`
  //      only when demoting (compare-and-set: only still-active admins are
  //      touched; a concurrent demotion of the same target is a no-op here).
  //   4. Post-update global re-count: if 0 active admins remain, throw to
  //      roll the whole batch back.
  //
  // Residual: two concurrent batches with DISJOINT admin target lists can
  // still both pass under TiDB REPEATABLE READ (each snapshot sees ≥1 admin
  // outside its own set). Admin-only + 20/min + sub-ms window; a fully
  // race-free fix needs a DB trigger. Strictly more robust than the prior
  // unguarded updateMany.
  if (demotes) {
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

  const NG_BATCH_LAST_ADMIN = "NG_BATCH_LAST_ADMIN";
  let resultCount: number;
  try {
    const r = await db.$transaction(async (tx) => {
      // Re-fetch the targets' live role/status inside the txn.
      const live = await tx.account.findMany({
        where: { id: { in: targetIds } },
        select: { id: true, role: true, status: true },
      });
      const liveStillActiveAdminIds = live
        .filter((t) => t.role === "ADMIN" && t.status === "ACTIVE")
        .map((t) => t.id);

      // Re-verify the last-admin invariant on fresh state (only when this
      // batch actually demotes a still-active admin).
      if (demotes && liveStillActiveAdminIds.length > 0) {
        const outside = await tx.account.count({
          where: {
            role: "ADMIN",
            status: "ACTIVE",
            id: { notIn: liveStillActiveAdminIds },
          },
        });
        if (outside < 1) {
          throw new Error(NG_BATCH_LAST_ADMIN);
        }
      }

      // Compare-and-set: when demoting, only touch rows that are STILL
      // active admins. When activating (non-demote), update all targets.
      const where =
        demotes && liveStillActiveAdminIds.length > 0
          ? {
              id: { in: liveStillActiveAdminIds },
              role: "ADMIN" as const,
              status: "ACTIVE" as const,
            }
          : { id: { in: targetIds } };

      const update = await tx.account.updateMany({ where, data });

      // Post-update global re-count (read-your-writes): if this batch
      // removed the last active admin, roll back.
      if (demotes) {
        const remaining = await tx.account.count({
          where: { role: "ADMIN", status: "ACTIVE" },
        });
        if (remaining < 1) {
          throw new Error(NG_BATCH_LAST_ADMIN);
        }
      }
      return update.count;
    });
    resultCount = r;
  } catch (e) {
    if (e instanceof Error && e.message === NG_BATCH_LAST_ADMIN) {
      return forbidden(
        "This batch would leave the system with no active administrators. Keep at least one admin outside the selection, or promote another account to admin first.",
      );
    }
    throw e;
  }

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
      count: resultCount,
      ids: targetIds,
      action,
      ...(action === "setRole" ? { role } : {}),
    },
    req,
  });

  return NextResponse.json({
    ok: true,
    updated: resultCount,
    action,
  });
}

// NOTE: There is intentionally NO DELETE method on this route. Bulk hard-
// delete of accounts is too dangerous to expose as a single call - the
// existing single-account DELETE ?hard=true route (ADMIN-only, audited
// individually) remains the only path to permanent removal. This is a
// deliberate safety decision: an accidental bulk delete cannot wipe the
// account table, even by a compromised admin token.
