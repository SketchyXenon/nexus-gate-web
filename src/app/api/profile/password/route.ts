import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { changePasswordSchema } from "@/lib/validation";
import { badRequest, forbidden, parseBody, requireAuth, unauthorized } from "@/lib/api";
import { audit } from "@/lib/audit";
import { isCooldownExpired, daysUntilCooldownExpires } from "@/lib/cooldown";

// ====================================================================
// POST /api/profile/password — change own password
// Requires current password for verification.
// Revokes all other sessions after password change.
//
// SERVER-SIDE VALIDATIONS (cannot be bypassed by the client):
//   1. Input shape + password STRENGTH (Zod schema + scorePassword)
//      — runs FIRST so weak passwords are always rejected, even during
//        the cooldown period. A malicious client cannot bypass this.
//   2. 30-day cooldown since last password change
//   3. Current password must be correct
//   4. New password must differ from the current one
// ====================================================================

export async function POST(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  // ---- SERVER-SIDE VALIDATION: Input shape + password STRENGTH ----
  // This runs BEFORE the cooldown check so that weak passwords are always
  // rejected with a clear error — never the cooldown message. The
  // changePasswordSchema uses strongPasswordSchema which runs the shared
  // scorePassword() function and requires a minimum score of 4.
  const body = await parseBody(req);
  const parsed = changePasswordSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const { currentPassword, newPassword } = parsed.data;

  // ---- Fetch current password hash + lastPasswordChangeAt + authProvider ----
  const fullAccount = await db.account.findUnique({
    where: { id: account.id },
    select: { passwordHash: true, authProvider: true, lastPasswordChangeAt: true },
  });

  if (!fullAccount) return unauthorized();

  // ---- SERVER-SIDE VALIDATION: 30-day password change cooldown ----
  // If the user has changed their password before, they must wait 30 days
  // before changing it again. The FIRST password set (e.g. for OAuth
  // accounts setting a password for the first time) is exempt —
  // lastPasswordChangeAt is null until the first change.
  if (!isCooldownExpired(fullAccount.lastPasswordChangeAt)) {
    const daysLeft = daysUntilCooldownExpires(fullAccount.lastPasswordChangeAt);
    return forbidden(
      `You can change your password again in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`,
      "PASSWORD_COOLDOWN"
    );
  }

  // OAuth accounts (empty password hash) can set a password
  if (fullAccount.authProvider && !fullAccount.passwordHash) {
    // Allow setting password for the first time (no current password needed)
  } else {
    // Verify current password
    const valid = await verifyPassword(currentPassword, fullAccount.passwordHash);
    if (!valid) {
      return badRequest("Your current password is incorrect.", "WRONG_PASSWORD");
    }
  }

  // Don't allow same password (skip for OAuth-only accounts with no existing password)
  if (fullAccount.passwordHash) {
    const samePassword = await verifyPassword(newPassword, fullAccount.passwordHash);
    if (samePassword) {
      return badRequest("Your new password must be different from your current one.", "SAME_PASSWORD");
    }
  }

  const newHash = await hashPassword(newPassword);

  // Update password, stamp lastPasswordChangeAt, and revoke all other sessions
  await db.$transaction([
    db.account.update({
      where: { id: account.id },
      data: {
        passwordHash: newHash,
        lastPasswordChangeAt: new Date(),
      },
    }),
    // Revoke all refresh tokens (forces re-login on other devices)
    db.refreshToken.updateMany({
      where: { accountId: account.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  await audit({
    actorId: account.id, action: "profile.password_change", targetType: "Account",
    targetId: account.id, req,
  });

  return NextResponse.json({
    ok: true,
    message: "Password updated. You'll need to sign in again on other devices.",
    canChangePassword: false,
    daysUntilPasswordChange: 30,
  });
}
