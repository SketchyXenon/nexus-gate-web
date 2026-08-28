// Allow up to 15s for Supabase admin.deleteUser.
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  forbidden,
  notFound,
  requireAuth,
  checkRateLimitByKey,
  dbUnavailable,
  isDbUnavailableError,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  createSupabaseAdminClient,
  isSupabaseAdminConfigured,
} from "@/lib/supabase-server";
import { invalidateAccountCache } from "@/lib/supabase-session";

type Ctx = { params: Promise<{ id: string }> };

// DELETE /api/accounts/[id]/delete (ADMIN only)
// Deletes the accounts row AND the linked Supabase Auth user (if any).
// Without deleting both, a re-register with the same email would fail
// ("already registered") because the auth.users entry survives.
export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const res = await requireAuth("ADMIN");
    if ("error" in res) return res.error;
    const { account: admin } = res;
    const { id } = await params;

    // Tighter rate limit for admin destructive mutations (20/min).
    // Account deletion hits Supabase Auth + cascades to attendance/tokens.
    // Fails CLOSED on limiter error.
    const adminRl = await checkRateLimitByKey(admin.id, "adminMutation");
    if (adminRl) return adminRl;

    if (admin.id === id) {
      return forbidden("You cannot delete your own account.");
    }

    const target = await db.account.findUnique({
      where: { id },
      select: { id: true, email: true, role: true, supabaseAuthUid: true },
    });
    if (!target) return notFound("Account not found");

    if (target.role === "ADMIN") {
      const adminCount = await db.account.count({
        where: { role: "ADMIN", status: "ACTIVE" },
      });
      if (adminCount <= 1) {
        return forbidden("Cannot delete the last administrator account.");
      }
    }

    // Pre-check: block deletion if the account owns any events. The FK
    // constraint (events_owner_id_fkey ON DELETE RESTRICT) would throw
    // P2003; checking first lets us return a clear, actionable message.
    const ownedEventCount = await db.event.count({ where: { ownerId: id } });
    if (ownedEventCount > 0) {
      return forbidden(
        `This account owns ${ownedEventCount} event(s). Reassign or delete those events before deleting the account.`,
        "OWNS_EVENTS",
      );
    }

    // Revoke all refresh tokens first (clean up sessions).
    await db.refreshToken.updateMany({
      where: { accountId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Delete the Supabase Auth user (if linked). This prevents the
    // "already registered" error when someone re-registers the same email.
    //
    // HONESTY CONTRACT (per 06-security-architecture.md §2 "defense in depth"
    // + ARCHITECTURE-SECURITY.md §9 "no catastrophic hard-deletes"):
    // The previous version of this block SWALLOWED every auth-delete failure
    // (wrong key, network error, missing SUPABASE_SERVICE_ROLE_KEY, mock not
    // implementing deleteUser) into a console.error, deleted the DB row, and
    // returned `{ deleted: true }` — misleading the admin into believing the
    // account was fully removed while the auth.users entry survived as an
    // orphan. We now track the outcome and surface it in the response
    // (`authUserDeleted`, `orphanUid`, `warning`) so the admin is never
    // misled, and audit it as `account.delete.auth_orphan` for traceability.
    // We still proceed with the DB delete (the admin's intent) — blocking it
    // would just trap the account in a half-state. The admin can now act on
    // the warning (manual cleanup in Supabase Authentication → Users).
    let authUserDeleted = false;
    let authSkipReason: string | null = null;
    let orphanUid: string | null = null;

    if (target.supabaseAuthUid) {
      if (!isSupabaseAdminConfigured()) {
        // No service-role key — admin.deleteUser is impossible. Don't
        // construct a broken client (it would throw inside the SDK and
        // produce the same swallowed error as before). Record the precise
        // reason so the admin knows exactly what to fix.
        authSkipReason =
          "SUPABASE_SERVICE_ROLE_KEY not configured on the server";
        orphanUid = target.supabaseAuthUid;
      } else {
        try {
          const adminClient = createSupabaseAdminClient();
          const { error: authDeleteError } =
            await adminClient.auth.admin.deleteUser(target.supabaseAuthUid);
          if (authDeleteError) {
            authSkipReason = authDeleteError.message;
            orphanUid = target.supabaseAuthUid;
            console.error(
              "[account.delete] WARNING: Supabase auth user could not be deleted. Manual cleanup needed:",
              authDeleteError.message,
              "uid:",
              target.supabaseAuthUid,
            );
          } else {
            authUserDeleted = true;
          }
        } catch (e) {
          authSkipReason = e instanceof Error ? e.message : String(e);
          orphanUid = target.supabaseAuthUid;
          console.error(
            "[account.delete] WARNING: Supabase admin client error. Manual cleanup needed:",
            e,
            "uid:",
            target.supabaseAuthUid,
          );
        }
      }
    }

    // ---- Last-admin guard (TOCTOU-safe) + DB delete ----
    // Wrap the re-check + delete in a transaction. The pre-check above is
    // a fast-path reject; this re-verifies inside the txn so that if the
    // target was the last admin (snapshot drift or a concurrent demotion
    // racing the pre-check), we roll back and return 403 instead of
    // orphaning the system with zero admins.
    //
    // We deliberately run the Supabase Auth user-delete ABOVE (outside the
    // txn) so the DB transaction isn't held open over a network call. If
    // the DB delete below rolls back, the auth user is already gone — but
    // the row survives and the admin can re-link via a fresh Supabase
    // user. This matches the existing "log and continue" posture.
    if (target.role === "ADMIN") {
      try {
        await db.$transaction(async (tx) => {
          const remaining = await tx.account.count({
            where: { role: "ADMIN", status: "ACTIVE" },
          });
          if (remaining <= 1) {
            throw new Error("NG_LAST_ADMIN_VIOLATION");
          }
          await tx.account.delete({ where: { id } });
        });
      } catch (e) {
        if (e instanceof Error && e.message === "NG_LAST_ADMIN_VIOLATION") {
          return forbidden("Cannot delete the last administrator account.");
        }
        throw e;
      }
    } else {
      await db.account.delete({ where: { id } });
    }

    // Invalidate the session cache so the deleted user loses access
    // immediately instead of retaining it for up to the 30s cache TTL.
    if (target.supabaseAuthUid) {
      invalidateAccountCache(target.supabaseAuthUid);
    }

    await audit({
      actorId: admin.id,
      action: "account.delete",
      targetType: "Account",
      targetId: id,
      metadata: {
        email: target.email,
        role: target.role,
        authUserDeleted,
        ...(authUserDeleted ? {} : { orphanUid: orphanUid ?? undefined }),
      },
      req,
    });

    // If the Supabase auth user survived (no service key, or the delete
    // call failed), audit a SEPARATE orphan event so breach/audit log
    // queries can find every half-deleted account without parsing the
    // metadata blob above. Mirrors the login route's reverse-direction
    // orphan reconciliation (which cleans DB rows when the auth user is
    // gone) — this is the forward direction: the auth user survived.
    if (!authUserDeleted && orphanUid) {
      await audit({
        actorId: admin.id,
        action: "account.delete.auth_orphan",
        targetType: "Account",
        targetId: id,
        metadata: {
          email: target.email,
          supabaseAuthUid: orphanUid,
          reason: authSkipReason ?? "unknown",
        },
        req,
      }).catch(() => {
        // Non-fatal: the primary audit + the DB delete already succeeded.
        // The admin still sees the warning in the HTTP response.
      });
    }

    return NextResponse.json({
      ok: true,
      deleted: true,
      authUserDeleted,
      // Only attach the warning fields when the auth user survived —
      // keeps the success response clean for the happy path.
      ...(authUserDeleted
        ? {}
        : {
            orphanUid,
            warning: `Supabase auth user was NOT deleted${
              authSkipReason ? `: ${authSkipReason}` : ""
            }. Manual cleanup required: remove uid ${orphanUid} from Supabase Authentication → Users, otherwise re-registering ${target.email} will fail with "already registered".`,
          }),
    });
  } catch (e) {
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    throw e;
  }
}
