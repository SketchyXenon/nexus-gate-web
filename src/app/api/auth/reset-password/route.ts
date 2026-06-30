import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword, hashResetToken } from "@/lib/auth";
import { resetPasswordSchema } from "@/lib/validation";
import { badRequest, checkRateLimit, parseBody, getClientIp } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";

// ====================================================================
// POST /api/auth/reset-password
// --------------------------------------------------------------------
// Strict rate limiting: max 2 reset attempts per IP per hour.
// Prevents brute-force token guessing.
// Consumes a single-use password-reset token and sets a new password.
// Token lookup is by SHA-256 hash (the raw token never touches the DB).
// A valid token must:
//   - match purpose="PASSWORD_RESET"
//   - have usedAt=null (single-use)
//   - have expiresAt > now (30-minute TTL)
//
// On success:
//   - the new password is hashed and stored
//   - failedLoginAttempts is cleared and lockedUntil is unset
//   - the token is marked used (so it can't be replayed)
//   - all existing refresh tokens for the account are revoked (forces
//     re-login on every other device)
//   - the action is audit-logged
//
// On any failure we return 400 INVALID_TOKEN with no detail — this
// prevents an attacker from distinguishing "no such token" from
// "expired" from "already used".
// ====================================================================

export async function POST(req: NextRequest) {
  // ---- Standard rate limit (3/min) ----
  const rl = await checkRateLimit(req, "otp");
  if (rl) return rl;

  // ---- Strict IP limit: max 2 reset attempts per hour ----
  const ip = getClientIp(req);
  const ipKey = `resetpw-strict:ip:${ip}`;
  const ipResult = await rateLimit(ipKey, "otp");
  if (!ipResult.allowed) {
    return NextResponse.json(
      { error: "Too many password reset attempts from this network. Please try again later.", code: "IP_RATE_LIMITED" },
      { status: 429 }
    );
  }

  const body = await parseBody(req);
  const parsed = resetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      parsed.error.issues[0]?.message ?? "Invalid input",
      "INVALID_TOKEN"
    );
  }
  const { token, password } = parsed.data;

  // Hash the submitted token and look it up. We only ever store hashes,
  // so a DB leak can't be replayed.
  const tokenHash = hashResetToken(token);
  const now = new Date();

  const resetToken = await db.verificationToken.findFirst({
    where: {
      codeHash: tokenHash,
      purpose: "PASSWORD_RESET",
      usedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true, accountId: true, expiresAt: true },
  });

  if (!resetToken) {
    // Don't reveal WHY the token is invalid (used / expired / unknown).
    return badRequest(
      "This reset link is invalid or has expired. Please request a new one.",
      "INVALID_TOKEN"
    );
  }

  // Hash the new password (bcrypt, 12 rounds — same as registration).
  const newHash = await hashPassword(password);

  // Apply the password change + clear lockout state + revoke sessions,
  // all in a single transaction. If any step fails, nothing is committed.
  await db.$transaction([
    db.account.update({
      where: { id: resetToken.accountId },
      data: {
        passwordHash: newHash,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    }),
    db.verificationToken.update({
      where: { id: resetToken.id },
      data: { usedAt: now },
    }),
    db.refreshToken.updateMany({
      where: { accountId: resetToken.accountId, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);

  await audit({
    actorId: resetToken.accountId,
    action: "auth.password_reset",
    targetType: "Account",
    targetId: resetToken.accountId,
    req,
  });

  return NextResponse.json({
    ok: true,
    message:
      "Your password has been reset. You can now sign in with your new password.",
  });
}
