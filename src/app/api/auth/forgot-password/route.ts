import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  generateResetToken,
  hashResetToken,
  PASSWORD_RESET_TTL_MS,
} from "@/lib/auth";
import { forgotPasswordSchema } from "@/lib/validation";
import { checkRateLimit, parseBody, getClientIp } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { sendPasswordResetEmail, isEmailConfigured } from "@/lib/email";

// ====================================================================
// POST /api/auth/forgot-password
// --------------------------------------------------------------------
// Strict rate limiting: max 2 requests per IP per hour.
// Returns the SAME response for existing and non-existing emails
// (enumeration-safe).
// ====================================================================

// Strict IP-based limit: 2 per hour per IP
// Always returns 200 with the same message — this is enumeration-safe:
// whether the email exists or not, the response is identical so an
// attacker can't probe which addresses have accounts.
//
// Behind the scenes:
//   - If the account exists AND has a passwordHash (not OAuth-only),
//     we mint a reset token, store its hash in VerificationToken with
//     purpose="PASSWORD_RESET", and email the reset link.
//   - If SMTP is not configured, the reset link is logged to the console
//     (dev fallback — same pattern as the OTP flow).
//   - The action is audit-logged (success or "skipped" for OAuth-only).
// ====================================================================

const SAFE_RESPONSE = {
  ok: true,
  message:
    "If an account with that email exists, a reset link has been sent.",
};

export async function POST(req: NextRequest) {
  // ---- Standard rate limit (3/min) ----
  const rl = await checkRateLimit(req, "otp");
  if (rl) return rl;

  // ---- Strict IP limit: max 2 forgot-password per hour ----
  const ip = getClientIp(req);
  const ipKey = `forgotpw-strict:ip:${ip}`;
  const ipResult = await rateLimit(ipKey, "otp");
  if (!ipResult.allowed) {
    return NextResponse.json(
      { error: "Too many password reset requests from this network. Please try again later.", code: "IP_RATE_LIMITED" },
      { status: 429 }
    );
  }

  const body = await parseBody(req);
  const parsed = forgotPasswordSchema.safeParse(body);
  if (!parsed.success) {
    // Still return 200 — enumeration-safe. Validation failure must not leak.
    return NextResponse.json(SAFE_RESPONSE, { status: 200 });
  }
  const { email } = parsed.data;

  // Look up the account silently. We never reveal whether it exists.
  const account = await db.account.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      fullName: true,
      passwordHash: true,
      authProvider: true,
    },
  });

  if (!account) {
    // No account — audit-log the attempt without revealing anything.
    await audit({
      actorId: null,
      action: "auth.password_reset_requested",
      targetType: "Account",
      targetId: null,
      metadata: { email, outcome: "no_account" },
      req,
    });
    return NextResponse.json(SAFE_RESPONSE, { status: 200 });
  }

  // OAuth-only accounts (Google sign-in, no password) can't reset a
  // password they never set. We still return the safe message.
  const isOAuthOnly = Boolean(account.authProvider) && !account.passwordHash;
  if (isOAuthOnly) {
    await audit({
      actorId: account.id,
      action: "auth.password_reset_requested",
      targetType: "Account",
      targetId: account.id,
      metadata: { email, outcome: "oauth_only_skipped" },
      req,
    });
    return NextResponse.json(SAFE_RESPONSE, { status: 200 });
  }

  // Invalidate any previous unused reset tokens for this account so
  // only the newest link is valid.
  await db.verificationToken.updateMany({
    where: {
      accountId: account.id,
      purpose: "PASSWORD_RESET",
      usedAt: null,
    },
    data: { usedAt: new Date() },
  });

  // Mint a fresh token. Store only the SHA-256 hash — the raw token
  // never touches the database.
  const rawToken = generateResetToken();
  const tokenHash = hashResetToken(rawToken);
  await db.verificationToken.create({
    data: {
      accountId: account.id,
      codeHash: tokenHash,
      purpose: "PASSWORD_RESET",
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    },
  });

  // Build the reset URL the user will click in the email.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const resetUrl = `${appUrl}/?reset=${encodeURIComponent(rawToken)}`;

  // Send the email. If SMTP isn't configured (or sending fails), log
  // the link to the console so the flow still works in development.
  const emailConfigured = isEmailConfigured();
  let emailed = false;
  if (emailConfigured) {
    const result = await sendPasswordResetEmail(account.email, resetUrl);
    emailed = result.ok;
    if (!result.ok) {
      console.error("[forgot-password] email send failed:", result.error);
    }
  }
  if (!emailed) {
    console.warn(
      "[forgot-password] SMTP not configured — reset link for " +
        account.email +
        ":\n  " +
        resetUrl
    );
  }

  await audit({
    actorId: account.id,
    action: "auth.password_reset_requested",
    targetType: "Account",
    targetId: account.id,
    metadata: { email, outcome: emailed ? "emailed" : "dev_link_logged" },
    req,
  });

  return NextResponse.json(SAFE_RESPONSE, { status: 200 });
}
