// POST /api/auth/mfa/verify
// Confirm the enrollment: the user has scanned the QR with their
// authenticator and is now submitting a 6-digit code. We verify it
// against the persisted secret. On success, flip mfaEnabled=true, set
// mfaEnabledAt, generate 10 one-time backup codes (returned ONCE), and
// persist their bcrypt hashes in mfaBackupCodesHash (JSON).
//
// Rate-limited: 5/min per accountId. Audits auth.mfa_verify_success /
// auth.mfa_verify_failed. Per 06-security-architecture.md §2:
// brute-force defense for the MFA lifecycle, not just login.
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  badRequest,
  checkRateLimitByKey,
  parseBody,
  requireAuth,
  tooManyRequests,
  unauthorized,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import { decryptSecret, generateBackupCodes, verifyTotp } from "@/lib/mfa";
import { invalidateAccountCache } from "@/lib/supabase-session";

export async function POST(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  // Account-scoped rate limit (5/min).
  const rl = await checkRateLimitByKey(account.id, "mfaAccount");
  if (rl) return tooManyRequests(0);

  // Parse + validate the body. Code is a 6-digit (or 8-digit) string;
  // spaces are stripped by verifyTotp.
  const body = await parseBody<{ code?: unknown }>(req);
  if (!body || typeof body.code !== "string") {
    return badRequest("Enter the 6-digit code from your authenticator.");
  }

  // Load the persisted secret + current mfaEnabled state.
  let row: {
    mfaSecretEnc: string | null;
    mfaEnabled: boolean | null;
  } | null = null;
  try {
    row = await db.account.findUnique({
      where: { id: account.id },
      select: { mfaSecretEnc: true, mfaEnabled: true },
    });
  } catch (e) {
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code: string }).code === "P2022"
    ) {
      return NextResponse.json(
        {
          error:
            "MFA is not available on this server yet. Please contact an administrator.",
          code: "MFA_NOT_AVAILABLE",
        },
        { status: 503 },
      );
    }
    throw e;
  }

  if (!row || !row.mfaSecretEnc) {
    // No secret persisted - the user hasn't started enrollment. Treat
    // as bad request (the UI shouldn't be here).
    return badRequest("Start MFA enrollment first.");
  }

  // If MFA is already enabled, don't let this route re-issue backup codes.
  // The disable flow is the only way to turn it off; re-enroll from there.
  if (row.mfaEnabled) {
    return NextResponse.json(
      {
        error: "MFA is already enabled for this account.",
        code: "MFA_ALREADY_ENABLED",
      },
      { status: 409 },
    );
  }

  let secret: string;
  try {
    secret = decryptSecret(row.mfaSecretEnc);
  } catch {
    // The encrypted blob is malformed OR the env secret changed. Fail
    // closed: deny the verification. The user must re-enroll (which
    // overwrites the secret).
    return unauthorized("Could not verify the code. Please re-enroll MFA.");
  }

  const valid = verifyTotp({ token: body.code, secret });
  if (!valid) {
    await audit({
      actorId: account.id,
      action: "auth.mfa_verify_failed",
      targetType: "Account",
      targetId: account.id,
      metadata: {},
      req,
    });
    return unauthorized("Incorrect code. Try again.");
  }

  // Generate the one-time backup codes. Hashes are persisted; plaintext
  // is returned exactly once.
  const { plaintext, hashes } = generateBackupCodes();
  const now = new Date();
  try {
    const updated = await db.account.update({
      where: { id: account.id },
      data: {
        mfaEnabled: true,
        mfaEnabledAt: now,
        mfaBackupCodesHash: JSON.stringify(hashes),
      },
      select: { supabaseAuthUid: true },
    });
    if (updated.supabaseAuthUid) {
      invalidateAccountCache(updated.supabaseAuthUid);
    }
  } catch (e) {
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code: string }).code === "P2022"
    ) {
      return NextResponse.json(
        {
          error:
            "MFA is not available on this server yet. Please contact an administrator.",
          code: "MFA_NOT_AVAILABLE",
        },
        { status: 503 },
      );
    }
    throw e;
  }

  await audit({
    actorId: account.id,
    action: "auth.mfa_verify_success",
    targetType: "Account",
    targetId: account.id,
    metadata: {},
    req,
  });

  // NOTE: after this route returns, the user's CURRENT browser session
  // is no longer sufficient: mfaEnabled=true, but this route does NOT
  // set the ng_mfa_verified cookie. The next requireAuth-protected call
  // will return 401. That's the secure behavior: the user just turned
  // MFA on, so the existing session's assurance level (password-only)
  // is no longer enough. The UI shows the backup codes, then signs the
  // user out so the next sign-in goes through the full MFA flow.
  return NextResponse.json(
    { backupCodes: plaintext },
    { headers: { "Cache-Control": "no-store" } },
  );
}
