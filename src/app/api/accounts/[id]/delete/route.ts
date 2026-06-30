import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, notFound, requireAuth } from "@/lib/api";
import { audit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

// ====================================================================
// DELETE /api/accounts/[id]/delete (ADMIN only)
// Permanently deletes an account and cascades all related data
// (attendance, overrides, refresh tokens, verification tokens).
// AuditLog entries are preserved with actorId set to null.
// Admins cannot delete their own account.
// ====================================================================
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const res = await requireAuth("ADMIN");
  if ("error" in res) return res.error;
  const { account: admin } = res;
  const { id } = await params;

  // Prevent self-deletion
  if (admin.id === id) {
    return forbidden("You cannot delete your own account.");
  }

  const target = await db.account.findUnique({ where: { id } });
  if (!target) return notFound("Account not found");

  // Prevent deleting the last admin
  if (target.role === "ADMIN") {
    const adminCount = await db.account.count({ where: { role: "ADMIN", status: "ACTIVE" } });
    if (adminCount <= 1) {
      return forbidden("Cannot delete the last administrator account.");
    }
  }

  // Revoke all refresh tokens first (clean up sessions)
  await db.refreshToken.updateMany({
    where: { accountId: id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  // Delete the account (cascades to attendance, overrides, tokens)
  await db.account.delete({ where: { id } });

  await audit({
    actorId: admin.id, action: "account.delete", targetType: "Account",
    targetId: id, metadata: { email: target.email, role: target.role }, req,
  });

  return NextResponse.json({ ok: true, deleted: true });
}
