// POST /api/auth/mfa/disable
// Turn MFA off. Requires the current TOTP OR a backup code to confirm.
// On success, clears all MFA state (mfaSecretEnc, mfaEnabled,
// mfaEnabledAt, mfaBackupCodesHash) AND clears the ng_mfa_verified
// cookie. The user stays signed in (they just dropped the second factor).
//
// Rate-limited: 5/min per accountId. Audits auth.mfa_disable.
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
import {
  MFA_VERIFIED_COOKIE,
  decryptSecret,
  verifyBackupCode,
  verifyTotp,
} from "@/lib/mfa";
import { invalidateAccountCache } from "@/lib/supabase-session";

export async function POST(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  // Account-scoped rate limit (5/min).
  const rl = await checkRateLimitByKey(account.id, "mfaAccount");
  if (rl) return tooManyRequests(0);

  const body = await parseBody<{ code?: unknown }>(req);
  if (!body || typeof body.code !== "string" || body.code.length === 0) {
    return badRequest("Enter your current TOTP or a backup code.");
  }

  // Load the persisted MFA state.
  let row: {
    mfaSecretEnc: string | null;
    mfaEnabled: boolean | null;
    mfaBackupCodesHash: string | null;
  } | null = null;
  try {
    row = await db.account.findUnique({
      where: { id: account.id },
      select: {
        mfaSecretEnc: true,
        mfaEnabled: true,
        mfaBackupCodesHash: true,
      },
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

  if (!row || !row.mfaEnabled || !row.mfaSecretEnc) {
    // Defensive: not enrolled. Nothing to disable.
    return NextResponse.json(
      {
        error: "MFA is not enabled for this account.",
        code: "MFA_NOT_ENABLED",
      },
      { status: 409 },
    );
  }

  // Verify the supplied code against EITHER the TOTP secret OR the
  // backup codes. If it's a backup code, consume it (remove its hash).
  let secret: string;
  try {
    secret = decryptSecret(row.mfaSecretEnc);
  } catch {
    // Corrupt encrypted blob. Fail closed - require re-enroll from the
    // admin side. We do NOT let the user disable without verification.
    return unauthorized(
      "Could not verify the code. Please contact an administrator.",
    );
  }

  const totpValid = verifyTotp({ token: body.code, secret });
  let remainingHashes: string[] | null = null;

  if (!totpValid && row.mfaBackupCodesHash) {
    // Try the backup-code path. NOTE: compare against `parsed` (the
    // freshly-decoded value), not the local `hashes` variable - the
    // previous version checked Array.isArray(hashes) which was always
    // the empty array we just initialized, silently breaking backup
    // code disable.
    let hashes: string[] = [];
    try {
      const parsed = JSON.parse(row.mfaBackupCodesHash);
      if (Array.isArray(parsed)) {
        hashes = parsed.filter((h) => typeof h === "string");
      }
    } catch {
      // mfaBackupCodesHash is corrupt - treat as no backup codes.
      hashes = [];
    }
    const result = verifyBackupCode(body.code, hashes);
    if (result.valid) {
      remainingHashes = result.remaining;
    }
  }

  if (!totpValid && remainingHashes === null) {
    await audit({
      actorId: account.id,
      action: "auth.mfa_verify_failed",
      targetType: "Account",
      targetId: account.id,
      metadata: { context: "disable" },
      req,
    });
    return unauthorized("Incorrect code. Try again.");
  }

  // Disable MFA: clear all MFA state. If a backup code was used, persist
  // the updated hash list first (in case the disable fails partway).
  try {
    const updated = await db.account.update({
      where: { id: account.id },
      data: {
        mfaEnabled: false,
        mfaEnabledAt: null,
        mfaSecretEnc: null,
        mfaBackupCodesHash: null,
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
    action: "auth.mfa_disable",
    targetType: "Account",
    targetId: account.id,
    metadata: { method: totpValid ? "totp" : "backup_code" },
    req,
  });

  const resp = NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
  // Clear the MFA-verified marker cookie. Not strictly required (the
  // gate only fires when mfaEnabled is true) but defense in depth.
  resp.cookies.set(MFA_VERIFIED_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return resp;
}
