// POST /api/auth/mfa/enroll
// Generate a new TOTP secret + otpauth URL, persist the secret encrypted,
// return both to the UI for QR rendering. The user then scans the QR,
// enters the 6-digit code at /api/auth/mfa/verify to confirm and turn
// MFA on. mfaEnabled stays false until verify succeeds.
//
// Rate-limited: 5/min per accountId (mfaAccount preset). Audits
// auth.mfa_enroll_start.
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, checkRateLimitByKey, tooManyRequests } from "@/lib/api";
import { audit } from "@/lib/audit";
import { buildOtpAuthUrl, encryptSecret, generateSecret } from "@/lib/mfa";
import { invalidateAccountCache } from "@/lib/supabase-session";

export async function POST(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  // Account-scoped rate limit (5/min). Same preset reused across enroll
  // / verify / disable. Per 06-security-architecture.md §2: brute-force
  // defense for the MFA lifecycle, not just login.
  const rl = await checkRateLimitByKey(account.id, "mfaAccount");
  if (rl) return tooManyRequests(0);

  // Defensive: if the account somehow already has a secret persisted but
  // mfaEnabled is false (e.g. started enrollment, abandoned, re-enrolling),
  // generate a fresh secret + new otpauth URL. The previous encrypted
  // blob is overwritten; the old QR is invalid the moment we overwrite.
  const secret = generateSecret();
  const otpauthUrl = buildOtpAuthUrl({
    email: account.email,
    secret,
  });
  const encrypted = encryptSecret(secret);

  try {
    const updated = await db.account.update({
      where: { id: account.id },
      data: {
        mfaSecretEnc: encrypted,
        // mfaEnabled stays false. The user must complete /verify.
        mfaEnabled: false,
        mfaEnabledAt: null,
        mfaBackupCodesHash: null,
      },
      select: { supabaseAuthUid: true },
    });
    // Cache key is the Supabase auth uid, not account.id. Invalidate so
    // the next requireAuth call sees the persisted (but disabled) secret.
    if (updated.supabaseAuthUid) {
      invalidateAccountCache(updated.supabaseAuthUid);
    }
  } catch (e) {
    // P2022: MFA columns missing (migration not applied). Surface as 503
    // so the user knows to contact admin.
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
    action: "auth.mfa_enroll_start",
    targetType: "Account",
    targetId: account.id,
    metadata: {},
    req,
  });

  return NextResponse.json(
    { secret, otpauthUrl },
    { headers: { "Cache-Control": "no-store" } },
  );
}
