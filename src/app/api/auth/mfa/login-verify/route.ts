// POST /api/auth/mfa/login-verify
// Public route (uses the challenge cookie, not requireAuth). Submits the
// 6-digit TOTP code OR a backup code. On success, sets the
// ng_mfa_verified cookie (marking this browser session as
// MFA-verified for this accountId) and, when remembered && role !==
// "ADMIN", sets the sticky ng_sess marker so the Supabase session
// persists for 30 days. Returns the same account payload shape as the
// login route's success response.
//
// Rate-limited: 10/min by challengeId (mfaVerify preset). Audits
// auth.mfa_login_success / auth.mfa_login_failed.
//
// Enumeration-safe: every non-success path returns a generic 401 with
// the SAME body ("Incorrect or expired code. Try again."). An attacker
// cannot distinguish: wrong code, expired challenge, consumed challenge,
// account disabled-during-window. (The login route's `mfa_required`
// response DOES reveal that email+password was correct AND MFA is on -
// that's the accepted UX trade-off per 06-security-architecture.md §2.)
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  checkRateLimitByKey,
  parseBody,
  tooManyRequests,
  unauthorized,
  dbUnavailable,
  isDbUnavailableError,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  createSupabaseServerClient,
  REMEMBER_MAX_AGE_S,
  SESSION_MARKER_COOKIE,
} from "@/lib/supabase-server";
import {
  MFA_CHALLENGE_COOKIE,
  MFA_VERIFIED_COOKIE,
  MFA_VERIFIED_REMEMBER_SECONDS,
  decryptSecret,
  signMfaVerified,
  verifyBackupCode,
  verifyChallenge,
  verifyTotp,
} from "@/lib/mfa";

const MAX_ATTEMPTS = 5;

// Single generic failure response. Per 06-security-architecture.md §2.
function loginMfaFailed() {
  return unauthorized("Incorrect or expired code. Try again.");
}

export async function POST(req: NextRequest) {
  try {
    // ---- Read + verify the challenge cookie ----
    // The login route set ng_mfa_challenge = signChallenge(challengeId,
    // accountId). The JWT is signed with SUPABASE_JWT_SECRET and
    // expires in 5 min. verifyChallenge returns null on any failure
    // (tampered, expired, wrong issuer, etc.).
    const challengeCookie = req.cookies.get(MFA_CHALLENGE_COOKIE)?.value;
    if (!challengeCookie) {
      return loginMfaFailed();
    }
    const challenge = await verifyChallenge(challengeCookie);
    if (!challenge) {
      return loginMfaFailed();
    }
    const { challengeId, accountId } = challenge;

    // ---- Rate-limit by challengeId (10/min) ----
    // Stops an attacker from replaying codes within the 5-min window.
    const rl = await checkRateLimitByKey(challengeId, "mfaVerify");
    if (rl) return tooManyRequests(0);

    // ---- Load the MfaChallenge row ----
    let challengeRow: {
      id: string;
      accountId: string;
      expiresAt: Date;
      consumedAt: Date | null;
      attempts: number;
    } | null = null;
    try {
      challengeRow = await db.mfaChallenge.findUnique({
        where: { id: challengeId },
      });
    } catch (e) {
      if (isDbUnavailableError(e)) return dbUnavailable(e);
      throw e;
    }
    if (!challengeRow || challengeRow.accountId !== accountId) {
      return loginMfaFailed();
    }
    if (challengeRow.consumedAt || challengeRow.expiresAt < new Date()) {
      // Challenge already used or expired. Generic 401 - no leak.
      return loginMfaFailed();
    }
    if (challengeRow.attempts >= MAX_ATTEMPTS) {
      // Lockout: mark consumed so the JWT can't be replayed.
      await db.mfaChallenge
        .update({
          where: { id: challengeId },
          data: { consumedAt: new Date() },
        })
        .catch(() => {});
      return tooManyRequests(0);
    }

    // ---- Load the Account ----
    // Need: mfaEnabled (defensive: account may have disabled MFA during
    // the 5-min window), mfaSecretEnc, mfaBackupCodesHash, and the
    // response-payload fields. Also supabaseAuthUid (to invalidate the
    // account cache after we reset failedLoginAttempts).
    let account: {
      id: string;
      email: string;
      fullName: string;
      role: string;
      status: string;
      studentId: number | null;
      program: string | null;
      section: string | null;
      supabaseAuthUid: string | null;
      mfaEnabled: boolean | null;
      mfaSecretEnc: string | null;
      mfaBackupCodesHash: string | null;
      failedLoginAttempts: number;
    } | null = null;
    try {
      account = await db.account.findUnique({
        where: { id: accountId },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          status: true,
          studentId: true,
          program: true,
          section: true,
          supabaseAuthUid: true,
          mfaEnabled: true,
          mfaSecretEnc: true,
          mfaBackupCodesHash: true,
          failedLoginAttempts: true,
        },
      });
    } catch (e) {
      if (isDbUnavailableError(e)) return dbUnavailable(e);
      throw e;
    }
    if (!account || !account.mfaEnabled || !account.mfaSecretEnc) {
      // Account was deleted or disabled MFA during the 5-min window.
      // Generic 401.
      return loginMfaFailed();
    }

    // ---- Parse + verify the code ----
    const body = await parseBody<{ code?: unknown; backupCode?: unknown }>(req);
    if (!body) {
      // Increment attempts so repeated empty POSTs eventually lock the
      // challenge. Don't reveal which step failed.
      await bumpAttempts(challengeId);
      return loginMfaFailed();
    }
    const code =
      typeof body.code === "string"
        ? body.code
        : typeof body.backupCode === "string"
          ? body.backupCode
          : "";
    if (code.length === 0) {
      await bumpAttempts(challengeId);
      return loginMfaFailed();
    }

    // Decrypt the secret. Any failure → fail closed.
    let secret: string;
    try {
      secret = decryptSecret(account.mfaSecretEnc);
    } catch {
      await bumpAttempts(challengeId);
      return loginMfaFailed();
    }

    // Try TOTP first (most common path), then backup codes.
    let totpValid = false;
    let backupRemaining: string[] | null = null;
    let usedBackup = false;

    if (typeof body.code === "string") {
      totpValid = verifyTotp({ token: code, secret });
    }
    if (
      !totpValid &&
      account.mfaBackupCodesHash &&
      typeof body.backupCode === "string"
    ) {
      // Parse the stored JSON hash list. NOTE: compare against `parsed`
      // (the freshly-decoded value), not the local `hashes` variable -
      // the previous version checked Array.isArray(hashes) which was
      // always the empty array we just initialized, silently breaking
      // backup-code login. This is the bug that previously made backup
      // codes unconditionally fail.
      let hashes: string[] = [];
      try {
        const parsed = JSON.parse(account.mfaBackupCodesHash);
        if (Array.isArray(parsed)) {
          hashes = parsed.filter((h) => typeof h === "string");
        }
      } catch {
        hashes = [];
      }
      const result = verifyBackupCode(code, hashes);
      if (result.valid) {
        backupRemaining = result.remaining;
        usedBackup = true;
      }
    }

    if (!totpValid && !usedBackup) {
      // Bump the attempt counter ATOMICALLY via updateMany with a WHERE
      // clause that requires attempts < MAX_ATTEMPTS AND consumedAt is
      // null. Concurrent wrong-code submissions beyond the lockout
      // threshold get count=0 and fail closed without revealing state.
      // (Previous read-then-write allowed N concurrent requests all
      // seeing attempts=N-1 to bypass the 5-attempt lockout - TOCTOU
      // brute-force amplifier per 06-security-architecture.md §6.)
      let lockedOut = false;
      try {
        const bump = await db.mfaChallenge.updateMany({
          where: {
            id: challengeId,
            consumedAt: null,
            attempts: { lt: MAX_ATTEMPTS },
          },
          data: { attempts: { increment: 1 } },
        });
        if (bump.count === 1) {
          // If THIS bump crossed the threshold, mark consumed
          // (idempotent across concurrent winners - both write the
          // same value; first commit wins, second sees consumedAt!=null
          // and writes nothing).
          const lock = await db.mfaChallenge.updateMany({
            where: {
              id: challengeId,
              attempts: { gte: MAX_ATTEMPTS },
              consumedAt: null,
            },
            data: { consumedAt: new Date() },
          });
          lockedOut = lock.count === 1;
        }
        // else: a concurrent request already locked or consumed - the
        // generic 401 covers both states. No audit (we don't know if
        // this request actually consumed an attempt).
      } catch {
        // DB error - the generic 401 is still the safe response.
      }
      await audit({
        actorId: account.id,
        action: "auth.mfa_login_failed",
        targetType: "Account",
        targetId: account.id,
        metadata: { lockedOut },
        req,
      }).catch(() => {});
      return loginMfaFailed();
    }

    // ---- Success: mark challenge consumed ATOMICALLY ----
    // Only the FIRST concurrent request to win gets count=1 and proceeds
    // to set the verified cookie + return the success payload. Concurrent
    // duplicates that verified the same TOTP within the 30s tolerance
    // window see count=0 (consumedAt now non-null) and fail closed.
    // (Previous non-atomic update let both consume and both set the
    // verified cookie - replay-attack amplifier per §6 race conditions.)
    let consumeResult: { count: number } | null = null;
    try {
      consumeResult = await db.mfaChallenge.updateMany({
        where: { id: challengeId, consumedAt: null },
        data: { consumedAt: new Date() },
      });
    } catch {
      // DB error - fail closed.
    }
    if (!consumeResult || consumeResult.count === 0) {
      // Already consumed by a concurrent request, or DB error. The
      // generic 401 is the safe response - no cookies, no payload leak.
      return loginMfaFailed();
    }

    // If a backup code was used, persist the updated hash list ATOMICALLY
    // via optimistic locking on the original JSON value. If another
    // request consumed the same code concurrently, the WHERE clause
    // won't match (the stored value has changed) and we fail closed -
    // the code is no longer valid in our snapshot. This stops a single
    // backup code from being redeemed multiple times in parallel.
    if (usedBackup && backupRemaining !== null) {
      const originalJson = account.mfaBackupCodesHash ?? "";
      let consumeBackup: { count: number } | null = null;
      try {
        consumeBackup = await db.account.updateMany({
          where: { id: account.id, mfaBackupCodesHash: originalJson },
          data: { mfaBackupCodesHash: JSON.stringify(backupRemaining) },
        });
      } catch {
        // DB error - fail closed.
      }
      if (!consumeBackup || consumeBackup.count === 0) {
        // The backup code was consumed by a concurrent request, OR the
        // stored value changed. Either way: this code is no longer
        // valid. The challenge is already consumed (above), so the user
        // must sign in again for a fresh challenge. Fail closed.
        return loginMfaFailed();
      }
    }

    // ---- Reset brute-force counters + lastLoginAt ----
    try {
      const updated = await db.account.update({
        where: { id: account.id },
        data: {
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
        },
        select: { supabaseAuthUid: true },
      });
      // Invalidate the account cache (keyed by supabaseAuthUid) so the
      // next requireAuth call re-fetches with the freshly-set lastLoginAt.
      if (updated.supabaseAuthUid) {
        // Avoid a circular import: invalidateAccountCache is exported
        // from supabase-session.ts. We use a dynamic import to keep
        // the module graph flat.
        const { invalidateAccountCache } =
          await import("@/lib/supabase-session");
        invalidateAccountCache(updated.supabaseAuthUid);
      }
    } catch {
      // Non-fatal: the cookie write + audit are the critical path.
    }

    // ---- Set the MFA-verified marker + ng_sess marker ----
    // Read the remember-me intent cookie that the login route set.
    // ADMIN accounts had `remembered` forced to false at the login
    // route (line 130), so this cookie is always "0" for them - their
    // ng_mfa_verified is session-scoped (no maxAge) and ng_sess is
    // deleted.
    const rememberCookie = req.cookies.get("ng_mfa_remember")?.value;
    const remembered = rememberCookie === "1" && account.role !== "ADMIN";
    const verifiedExpSeconds = remembered ? MFA_VERIFIED_REMEMBER_SECONDS : 0;
    const verifiedJwt = await signMfaVerified(account.id, verifiedExpSeconds);

    // Refresh the Supabase session cookie persistence by re-writing it
    // through the server client (same pattern as the login route's
    // final block). The createSupabaseServerClient picks up the
    // ng_sess marker to decide 30-day vs session-scoped persistence.
    // We DON'T need to call getUser() - the session cookie already
    // exists from the login route's signInWithPassword.
    if (remembered) {
      // Re-create the client with rememberSession=true so any subsequent
      // token refreshes apply 30-day persistence.
      await createSupabaseServerClient({ rememberSession: true });
    }

    // Build the response payload (same shape as the login route).
    const response = NextResponse.json(
      {
        id: account.id,
        email: account.email,
        fullName: account.fullName,
        role: account.role,
        status: account.status,
        studentId: account.studentId,
        program: account.program,
        section: account.section,
      },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } },
    );

    // Set ng_mfa_verified. expSeconds=0 means session-scoped (no maxAge).
    const verifiedCookieOpts: {
      httpOnly: boolean;
      sameSite: "lax";
      secure: boolean;
      path: string;
      maxAge?: number;
    } = {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    };
    if (verifiedExpSeconds > 0) {
      verifiedCookieOpts.maxAge = verifiedExpSeconds;
    }
    response.cookies.set(MFA_VERIFIED_COOKIE, verifiedJwt, verifiedCookieOpts);

    // Sticky ng_sess marker: same logic as the login route (lines 335-345).
    // When remembered AND not ADMIN, set ng_sess=p (30d). Otherwise delete
    // it so any previous remembered session on this browser can't leak.
    if (remembered) {
      response.cookies.set(SESSION_MARKER_COOKIE, "p", {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: REMEMBER_MAX_AGE_S,
      });
    } else {
      response.cookies.delete(SESSION_MARKER_COOKIE);
    }

    // Clear the challenge + remember cookies (one-time use).
    response.cookies.set(MFA_CHALLENGE_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 0,
    });
    response.cookies.set("ng_mfa_remember", "", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 0,
    });

    await audit({
      actorId: account.id,
      action: "auth.mfa_login_success",
      targetType: "Account",
      targetId: account.id,
      metadata: {
        rememberMe: remembered,
        role: account.role,
        method: usedBackup ? "backup_code" : "totp",
      },
      req,
    });

    return response;
  } catch (e) {
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    throw e;
  }
}

// Bump the attempt counter on a challenge row ATOMICALLY. Used by the
// empty-body and decrypt-error failure paths before returning the
// generic 401. The conditional WHERE clause (attempts < MAX_ATTEMPTS,
// consumedAt IS NULL) prevents concurrent wrong-code submissions from
// bypassing the 5-attempt lockout. Errors are swallowed - the response
// (generic 401) is what matters.
async function bumpAttempts(challengeId: string) {
  try {
    const bump = await db.mfaChallenge.updateMany({
      where: {
        id: challengeId,
        consumedAt: null,
        attempts: { lt: MAX_ATTEMPTS },
      },
      data: { attempts: { increment: 1 } },
    });
    if (bump.count === 1) {
      await db.mfaChallenge.updateMany({
        where: {
          id: challengeId,
          attempts: { gte: MAX_ATTEMPTS },
          consumedAt: null,
        },
        data: { consumedAt: new Date() },
      });
    }
  } catch {
    // Swallow - the caller returns the generic 401 regardless.
  }
}
