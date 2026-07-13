// Allow up to 15s for Supabase admin.deleteUser.
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  forbidden,
  notFound,
  requireAuth,
  dbUnavailable,
  isDbUnavailableError,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  createSupabaseAdminClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";

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

    if (admin.id === id) {
      return forbidden("You cannot delete your own account.");
    }

    const target = await db.account.findUnique({ where: { id } });
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
    // If the auth delete fails, we STILL delete the accounts row (so the
    // admin can proceed) but log the error for manual cleanup.
    if (target.supabaseAuthUid && isSupabaseConfigured()) {
      try {
        const adminClient = createSupabaseAdminClient();
        const { error: authDeleteError } =
          await adminClient.auth.admin.deleteUser(target.supabaseAuthUid);
        if (authDeleteError) {
          // Log prominently so the admin knows to manually clean up auth.users.
          console.error(
            "[account.delete] WARNING: Supabase auth user could not be deleted. Manual cleanup needed:",
            authDeleteError.message,
            "uid:",
            target.supabaseAuthUid,
          );
        }
      } catch (e) {
        console.error(
          "[account.delete] WARNING: Supabase admin client error. Manual cleanup needed:",
          e,
          "uid:",
          target.supabaseAuthUid,
        );
      }
    }

    // Delete the accounts row (cascades to attendance, overrides, tokens).
    await db.account.delete({ where: { id } });

    await audit({
      actorId: admin.id,
      action: "account.delete",
      targetType: "Account",
      targetId: id,
      metadata: { email: target.email, role: target.role },
      req,
    });

    return NextResponse.json({ ok: true, deleted: true });
  } catch (e) {
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    throw e;
  }
}
