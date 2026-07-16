// POST /api/profile/deactivate
//
// Self-service account deactivation (SOFT DELETE only).
// The account row is NEVER hard-deleted - only flagged as deactivated.
// This preserves all attendance records, audit logs, and event ownership
// for historical integrity while blocking the user from accessing the app.
//
// Security:
//   - Requires an authenticated session (requireAuth).
//   - Requires re-authentication with the current password (prevents
//     session-hijack deactivation) via Supabase signIn.
//   - Revokes all refresh tokens + signs out the active session.
//   - Invalidates the in-memory account cache (immediate effect).
//   - Audit-logged as "profile.deactivate".
//
// Recovery: an admin can restore the account via
// POST /api/accounts/[id]/restore.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { deactivateAccountSchema } from "@/lib/validation";
import {
  requireAuth,
  parseBody,
  badRequest,
  dbUnavailable,
  isDbUnavailableError,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  createSupabaseServerClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";
import { invalidateAccountCache } from "@/lib/supabase-session";

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    if ("error" in auth) return auth.error;
    const { account } = auth;

    const body = await parseBody(req);
    const parsed = deactivateAccountSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const { currentPassword, reason } = parsed.data;

    // Re-authenticate: verify the current password via Supabase signIn.
    // This prevents deactivation from a hijacked session.
    if (!isSupabaseConfigured()) {
      return badRequest("Unable to verify password. Please try again.");
    }
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: account.email,
      password: currentPassword,
    });
    if (error) {
      return badRequest("Incorrect password. Deactivation cancelled.");
    }

    // Soft-delete: flag as deactivated (never hard-delete).
    await db.account.update({
      where: { id: account.id },
      data: {
        isDeactivated: true,
        deactivatedAt: new Date(),
        deactivatedReason: reason || null,
        status: "DEACTIVATED",
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    // Revoke all refresh tokens (defense-in-depth).
    await db.refreshToken
      .updateMany({
        where: { accountId: account.id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      .catch(() => {});

    // Invalidate the in-memory cache so the next request sees the deactivation.
    // Fetch the supabaseAuthUid for cache invalidation.
    const acct = await db.account.findUnique({
      where: { id: account.id },
      select: { supabaseAuthUid: true },
    });
    if (acct?.supabaseAuthUid) {
      invalidateAccountCache(acct.supabaseAuthUid);
    }

    // Sign out the active Supabase session.
    await supabase.auth.signOut().catch(() => {});

    await audit({
      actorId: account.id,
      action: "profile.deactivate",
      targetType: "Account",
      targetId: account.id,
      metadata: { email: account.email, reason: reason || null },
      req,
    });

    return NextResponse.json(
      { ok: true, message: "Your account has been deactivated." },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    console.error("[deactivate] error:", e);
    return NextResponse.json(
      { ok: false, error: "Unable to deactivate account. Please try again." },
      { status: 500 },
    );
  }
}
