import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { updateAccountSchema } from "@/lib/validation";
import {
  badRequest,
  forbidden,
  notFound,
  parseBody,
  requireAuth,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import { invalidateAccountCache } from "@/lib/supabase-session";
import {
  createSupabaseAdminClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";

type Ctx = { params: Promise<{ id: string }> };

// Select shape used by every branch (demotion + plain update).
const ACCOUNT_SELECT = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  status: true,
  studentId: true,
  program: true,
  section: true,
  year: true,
  organizationName: true,
  lastLoginAt: true,
  createdAt: true,
  supabaseAuthUid: true,
} as const;

// Sentinel thrown inside the demotion transaction when the in-txn re-count
// detects the update would leave zero active admins. Caught at the boundary
// to convert into a clean 403 + rollback (compare-and-set on the global
// invariant; per 06-security-architecture.md §2 TOCTOU defense).
const LAST_ADMIN_VIOLATION = "NG_LAST_ADMIN_VIOLATION";

// PATCH /api/accounts/[id] (ADMIN)
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const res = await requireAuth("ADMIN");
  if ("error" in res) return res.error;
  const { account: admin } = res;
  const { id } = await params;

  const body = await parseBody(req);
  const parsed = updateAccountSchema.safeParse(body);
  if (!parsed.success)
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");

  const target = await db.account.findUnique({
    where: { id },
    select: { id: true, email: true, role: true, status: true },
  });
  if (!target) return notFound("Account not found");

  if (admin.id === id) {
    if (parsed.data.role && parsed.data.role !== admin.role) {
      return forbidden("You cannot change your own role");
    }
    if (parsed.data.status && parsed.data.status !== "ACTIVE") {
      return forbidden("You cannot suspend your own account");
    }
  }

  // Build the update payload once (shared by both branches).
  const data: Record<string, unknown> = {
    ...(parsed.data.role ? { role: parsed.data.role } : {}),
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
    ...(parsed.data.fullName ? { fullName: parsed.data.fullName } : {}),
    ...(parsed.data.email ? { email: parsed.data.email } : {}),
    ...(parsed.data.program !== undefined
      ? { program: parsed.data.program }
      : {}),
    ...(parsed.data.section !== undefined
      ? { section: parsed.data.section }
      : {}),
    ...(parsed.data.year !== undefined ? { year: parsed.data.year } : {}),
    ...(parsed.data.organizationName !== undefined
      ? { organizationName: parsed.data.organizationName }
      : {}),
  };

  // ---- Last-admin guard (TOCTOU-safe) ----
  // The demotion branch (ADMIN -> non-ADMIN, or ACTIVE -> non-ACTIVE) is
  // wrapped in a transaction. Inside the txn we:
  //   1. Re-check email conflict (atomic with the demotion).
  //   2. updateMany with `where: { id, role: "ADMIN", status: "ACTIVE" }`
  //      (compare-and-set on the target row -> closes the same-target race:
  //      if another request already demoted this account, count=0 and we
  //      surface a clean 409 instead of a stale overwrite).
  //   3. Re-count active admins INSIDE the txn (read-your-writes): if THIS
  //      update leaves 0, throw LAST_ADMIN_VIOLATION -> the txn rolls back.
  //
  // Residual: two concurrent demotions of the last TWO DIFFERENT admins can
  // still both pass under TiDB REPEATABLE READ (each snapshot sees 2). This
  // is an admin-only, rate-limited (20/min), sub-ms window; a fully race-free
  // fix needs a DB trigger (noted in the worklog). This is strictly more
  // robust than the prior unguarded `update`.
  const demotingAdmin =
    target.role === "ADMIN" &&
    ((parsed.data.role && parsed.data.role !== "ADMIN") ||
      (parsed.data.status && parsed.data.status !== "ACTIVE"));

  let updated: {
    id: string;
    email: string;
    fullName: string;
    role: string;
    status: string;
    studentId: number | null;
    program: string | null;
    section: string | null;
    year: number | null;
    organizationName: string | null;
    lastLoginAt: Date | null;
    createdAt: Date;
    supabaseAuthUid: string | null;
  };

  if (demotingAdmin) {
    type TxRes =
      | { kind: "ok"; updated: typeof updated }
      | { kind: "already_changed" }
      | { kind: "email_taken" }
      | { kind: "forbidden" };

    const txRes = await db
      .$transaction(async (tx) => {
        // 1. Email conflict re-check inside the txn (if email is changing).
        if (parsed.data.email && parsed.data.email !== target.email) {
          const conflict = await tx.account.findUnique({
            where: { email: parsed.data.email },
            select: { id: true },
          });
          if (conflict) return { kind: "email_taken" as const } satisfies TxRes;
        }
        // 2. Compare-and-set: only update if the target is STILL an active
        //    admin. count=0 means another request already changed it.
        const result = await tx.account.updateMany({
          where: { id, role: "ADMIN", status: "ACTIVE" },
          data,
        });
        if (result.count === 0) {
          return { kind: "already_changed" as const } satisfies TxRes;
        }
        // 3. In-txn re-count (read-your-writes): rollback if we just broke
        //    the invariant. Catches the case where the pre-check saw 2 but
        //    the target was the only admin (snapshot drift) — same-target
        //    race is already closed by the compare-and-set above.
        const remaining = await tx.account.count({
          where: { role: "ADMIN", status: "ACTIVE" },
        });
        if (remaining < 1) {
          throw new Error(LAST_ADMIN_VIOLATION);
        }
        const upd = (await tx.account.findUnique({
          where: { id },
          select: ACCOUNT_SELECT,
        })) as typeof updated | null;
        if (!upd) return { kind: "already_changed" as const } satisfies TxRes;
        return { kind: "ok" as const, updated: upd } satisfies TxRes;
      })
      .catch((e: unknown): TxRes => {
        if (e instanceof Error && e.message === LAST_ADMIN_VIOLATION) {
          return { kind: "forbidden" };
        }
        throw e;
      });

    if (txRes.kind === "forbidden") {
      return forbidden(
        "Cannot demote or suspend the last administrator account.",
      );
    }
    if (txRes.kind === "already_changed") {
      return NextResponse.json(
        {
          error:
            "This account's role or status just changed. Please refresh and try again.",
          code: "ACCOUNT_STATE_CHANGED",
        },
        { status: 409 },
      );
    }
    if (txRes.kind === "email_taken") {
      return badRequest("This email is already in use.", "EMAIL_TAKEN");
    }
    updated = txRes.updated;
  } else {
    // Non-demotion branch: no invariant to protect; keep the simple update
    // + the existing email-conflict pre-check.
    if (parsed.data.email && parsed.data.email !== target.email) {
      const emailExists = await db.account.findUnique({
        where: { email: parsed.data.email },
        select: { id: true },
      });
      if (emailExists) {
        return badRequest("This email is already in use.", "EMAIL_TAKEN");
      }
    }
    updated = (await db.account.update({
      where: { id },
      data,
      select: ACCOUNT_SELECT,
    })) as typeof updated;
  }

  // If role or status changed, revoke all sessions for that account
  if (parsed.data.role || parsed.data.status) {
    await db.refreshToken.updateMany({
      where: { accountId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Invalidate the account cache so the change takes effect immediately.
    if (updated.supabaseAuthUid) {
      invalidateAccountCache(updated.supabaseAuthUid);
    }
  }

  // Strip the internal Supabase Auth UID from the response (H4 leak).
  const { supabaseAuthUid: _omit, ...safeResponse } = updated as {
    supabaseAuthUid?: string;
  };

  // If email changed, sync to Supabase Auth so login uses the new email.
  if (
    parsed.data.email &&
    parsed.data.email !== target.email &&
    updated.supabaseAuthUid &&
    isSupabaseConfigured()
  ) {
    try {
      const adminClient = createSupabaseAdminClient();
      const { error: emailUpdateError } =
        await adminClient.auth.admin.updateUserById(updated.supabaseAuthUid, {
          email: parsed.data.email,
        });
      if (emailUpdateError) {
        console.error(
          "[accounts.update] WARNING: failed to sync email to Supabase Auth:",
          emailUpdateError.message,
          "uid:",
          updated.supabaseAuthUid,
        );
      }
    } catch (e) {
      console.error(
        "[accounts.update] WARNING: Supabase admin client error syncing email:",
        e,
      );
    }
  }

  await audit({
    actorId: admin.id,
    action: "account.update",
    targetType: "Account",
    targetId: id,
    metadata: parsed.data,
    req,
  });

  return NextResponse.json(safeResponse);
}
