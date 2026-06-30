import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkRateLimit, parseBody } from "@/lib/api";
import { audit } from "@/lib/audit";
import { setSessionCookies } from "@/lib/session";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";

// ====================================================================
// Passkey Authentication (Login)
// --------------------------------------------------------------------
// Step 1: POST /api/auth/passkey/verify (no body) → returns options
// Step 2: POST /api/auth/passkey/verify (body = assertion) → verifies + logs in
//
// This does NOT trigger concurrency issues with password login because:
//   • Passkey login creates a NEW session (same as password login)
//   • Anti-account-sharing revokes previous tokens on new login
//   • The student can only be logged in on one device at a time
//   • If someone logs in with passkey while another session is active,
//     the old session is revoked (same behavior as password login)
// ====================================================================

const RP_ID = process.env.NEXT_PUBLIC_APP_URL
  ? new URL(process.env.NEXT_PUBLIC_APP_URL).hostname
  : "localhost";

export async function POST(req: NextRequest) {
  const rl = await checkRateLimit(req, "login");
  if (rl) return rl;

  const body = await parseBody(req) as Record<string, unknown> | null;

  // ---- Step 1: Generate authentication options ----
  if (!body || !body.assertion) {
    // Allow user-less authentication (discoverable credentials / resident keys)
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      timeout: 60000,
      userVerification: "preferred",
      // No allowCredentials = discoverable credentials (resident keys).
      // The authenticator will prompt the user to pick a credential.
    });

    // Store challenge temporarily (use a cookie or in-memory for MVP)
    // In production, use Redis or a challenge table
    const response = NextResponse.json(options);
    response.cookies.set("ng_passkey_challenge", options.challenge, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 120, // 2 minutes
    });
    return response;
  }

  // ---- Step 2: Verify authentication response ----
  const challenge = req.cookies.get("ng_passkey_challenge")?.value || "";

  // SECURITY: Delete the challenge cookie immediately (single-use).
  // This prevents replay attacks where a captured challenge is reused.
  // The challenge is only valid for ONE verification attempt, regardless
  // of success or failure.
  const deleteChallengeCookie = (response: NextResponse) => {
    response.cookies.delete("ng_passkey_challenge");
    return response;
  };

  if (!challenge) {
    const response = NextResponse.json(
      { error: "Passkey challenge expired. Please try again." },
      { status: 401 }
    );
    return deleteChallengeCookie(response);
  }

  // Find the account that owns this credential
  // For MVP: search all accounts with passkey credentials
  const accounts = await db.account.findMany({
    where: { passkeyCredential: { not: null } },
    select: { id: true, email: true, fullName: true, role: true, status: true, studentId: true, program: true, section: true, passkeyCredential: true },
  });

  let verifiedAccount: typeof accounts[0] | null = null;

  for (const acc of accounts) {
    try {
      const stored = JSON.parse(acc.passkeyCredential || "{}");
      if (!stored.passkeyCredential) continue;

      const credential = JSON.parse(stored.passkeyCredential);

      const verification = await verifyAuthenticationResponse({
        response: body.assertion as AuthenticationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
        expectedRPID: RP_ID,
        credential,
      });

      if (verification.verified) {
        verifiedAccount = acc;
        // Update counter
        credential.counter = verification.authenticationInfo.newCounter;
        stored.passkeyCredential = JSON.stringify(credential);
        await db.account.update({
          where: { id: acc.id },
          data: { passkeyCredential: JSON.stringify(stored) },
        });
        break;
      }
    } catch {
      continue;
    }
  }

  if (!verifiedAccount) {
    return deleteChallengeCookie(
      NextResponse.json({ error: "Passkey verification failed." }, { status: 401 })
    );
  }

  if (verifiedAccount.status === "SUSPENDED") {
    return deleteChallengeCookie(
      NextResponse.json(
        { error: "Your account has been suspended. Please contact an administrator.", code: "SUSPENDED" },
        { status: 403 }
      )
    );
  }

  // Activate pending accounts (same as password login)
  if (verifiedAccount.status === "PENDING_VERIFICATION") {
    await db.account.update({
      where: { id: verifiedAccount.id },
      data: { status: "ACTIVE", lastLoginAt: new Date() },
    });
    (verifiedAccount as { status: string }).status = "ACTIVE";
  }

  // Revoke previous sessions (anti-account-sharing)
  await db.refreshToken.updateMany({
    where: { accountId: verifiedAccount.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await db.account.update({
    where: { id: verifiedAccount.id },
    data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  await setSessionCookies({
    accountId: verifiedAccount.id,
    role: verifiedAccount.role,
    status: verifiedAccount.status,
  });

  await audit({
    actorId: verifiedAccount.id,
    action: "auth.passkey_login",
    targetType: "Account",
    targetId: verifiedAccount.id,
    req,
  });

  const response = NextResponse.json({
    id: verifiedAccount.id,
    email: verifiedAccount.email,
    fullName: verifiedAccount.fullName,
    role: verifiedAccount.role,
    status: verifiedAccount.status,
    studentId: verifiedAccount.studentId,
    program: verifiedAccount.program,
    section: verifiedAccount.section,
  });
  response.cookies.delete("ng_passkey_challenge");
  return response;
}
