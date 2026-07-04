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

    // Revoke all refresh tokens first (clean up sessions).
    await db.refreshToken.updateMany({
      where: { accountId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Delete the Supabase Auth user (if linked). This prevents the
    // "already registered" error when someone re-registers the same email.
    if (target.supabaseAuthUid && isSupabaseConfigured()) {
      try {
        const adminClient = createSupabaseAdminClient();
        const { error: authDeleteError } =
          await adminClient.auth.admin.deleteUser(target.supabaseAuthUid);
        if (authDeleteError) {
          console.error(
            "[account.delete] Supabase auth user delete failed:",
            authDeleteError.message,
          );
        }
      } catch (e) {
        console.error("[account.delete] Supabase admin client error:", e);
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
