// POST /api/accounts/[id]/restore
//
// Admin-only: restores a deactivated (soft-deleted) account.
// Reverses the deactivation by clearing the isDeactivated flag and
// setting the status back to ACTIVE (if the email was verified) or
// PENDING_VERIFICATION (if not).
//
// This is the ONLY way to recover a deactivated account - the user
// cannot self-restore.

import { NextRequest, NextResponse } from "next/server";
import {
  requireAuth,
  notFound,
  forbidden,
  dbUnavailable,
  isDbUnavailableError,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import { invalidateAccountCache } from "@/lib/supabase-session";
import {
  safeFindAccountById,
  safeRestoreAccount,
  isAccountDeactivated,
} from "@/lib/safe-account";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireAuth("ADMIN");
    if ("error" in auth) return auth.error;
    const { account: admin } = auth;

    const { id } = await params;
    // Safe lookup: degrades if migration 0017 not applied.
    const target = await safeFindAccountById(id);

    if (!target) return notFound("Account not found.");
    if (!isAccountDeactivated(target)) {
      return forbidden("This account is not deactivated.", "NOT_DEACTIVATED");
    }

    // Restore: clear deactivation flags and set a sensible status.
    const restoredStatus = target.emailVerifiedAt
      ? "ACTIVE"
      : "PENDING_VERIFICATION";
    await safeRestoreAccount(target.id, Boolean(target.emailVerifiedAt));

    // Invalidate cache so the restored account can log in immediately.
    invalidateAccountCache(target.supabaseAuthUid ?? target.id);

    await audit({
      actorId: admin.id,
      action: "account.restore",
      targetType: "Account",
      targetId: target.id,
      metadata: {
        email: target.email,
        restoredStatus,
        deactivatedAt: target.deactivatedAt?.toISOString() ?? null,
      },
      req,
    });

    return NextResponse.json({
      ok: true,
      message: `Account restored with status "${restoredStatus}".`,
      account: {
        id: target.id,
        email: target.email,
        status: restoredStatus,
        isDeactivated: false,
      },
    });
  } catch (e) {
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    console.error("[restore] error:", e);
    return NextResponse.json(
      { ok: false, error: "Unable to restore account." },
      { status: 500 },
    );
  }
}
