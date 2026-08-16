// POST /api/profile/deactivate
//
// Self-service account deactivation (SOFT DELETE only).
// The account row is NEVER hard-deleted - only flagged as deactivated.
// This preserves all attendance records, audit logs, and event ownership
// for historical integrity while blocking the user from accessing the app.
//
// Security:
//  - Requires an authenticated session (requireAuth).
//  - Requires re-authentication with the current password (prevents
//     session-hijack deactivation) via Supabase signIn.
//  - Revokes all refresh tokens + signs out the active session.
//  - Invalidates the in-memory account cache (immediate effect).
//  - Audit-logged as "profile.deactivate".
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
import { safeDeactivateAccount } from "@/lib/safe-account";

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

    // Soft-delete (flag as deactivated). Use the safe helper so a missing
    // migration 0017 column (P2022) degrades to status-only update instead of
    // throwing a 500 "Unable to deactivate account". This was the root cause
    // of the reported deactivation-failure bug: the raw db.account.update used
    // the is_deactivated/deactivated_at/deactivated_reason columns, and if
    // migration 0017 wasn't applied, Prisma threw P2022 which fell through to
    // the generic 500 catch below (isDbUnavailableError does NOT catch P2022).
    await safeDeactivateAccount(account.id, reason || undefined);

    // Revoke all refresh tokens (defense-in-depth). Logged on failure so
    // operators can see partial deactivation, not silently swallowed.
    await db.refreshToken
      .updateMany({
        where: { accountId: account.id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      .catch((e) => {
        console.warn("[deactivate] refresh-token revoke failed:", e);
      });

    // Invalidate the in-memory + Redis account cache so the NEXT request sees
    // the deactivation immediately (without waiting for the 30s TTL). The
    // cache is keyed by supabaseAuthUid; ApiAccount doesn't carry it, so fetch
    // it (one indexed lookup). Fall back to account.id if null (best-effort).
    const acctRow = await db.account
      .findUnique({
        where: { id: account.id },
        select: { supabaseAuthUid: true },
      })
      .catch(() => null);
    const cacheKey = acctRow?.supabaseAuthUid ?? account.id;
    invalidateAccountCache(cacheKey);

    // Sign out the active Supabase session. On a server client this clears
    // the SSR-managed session cookie; getCurrentAccountSupabase also re-reads
    // the DB on every request so a lingering cookie is rejected at the DB
    // layer (isDeactivated check) until it naturally expires.
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
