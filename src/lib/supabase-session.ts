// Nexus Gate - Supabase Auth session layer.
// Resolves the current user from the Supabase session cookie.
//
// Primary path: local JWT validation via jose (0ms network, just crypto).
// Fallback path: supabase.auth.getUser() (50-150ms network round-trip).
// The JWT path is used when SUPABASE_JWT_SECRET is configured; otherwise
// the getUser() path is used.

import {
  createSupabaseServerClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";
import { db } from "@/lib/db";
import type { ApiAccount } from "@/lib/api";
import { getJwtSession, isJwtValidationAvailable } from "@/lib/jwt-session";
import { getAccountCache, setAccountCache } from "@/lib/account-cache";
import { cookies } from "next/headers";
import { MFA_VERIFIED_COOKIE, verifyMfaVerified } from "@/lib/mfa";

export interface SupabaseSession {
  authUid: string;
  email: string;
  /** True if the session is a password-reset (recovery) flow. */
  isRecovery?: boolean;
}

// Clear the cache for a specific user (called when account is updated).
export function invalidateAccountCache(authUid: string): void {
  // Delegate to the unified cache module (handles both Redis + in-memory).
  void setAccountCache(authUid, null, 0).catch(() => {});
}

// Decode a JWT payload without signature verification (for reading claims
// like AMR). Safe to use ONLY after the token has been validated by either
// jose (JWT path) or supabase.auth.getUser() (network path). The signature
// is NOT checked here - we only read the AMR claim.
function decodeAmrFromToken(token: string): boolean {
  const payload = token.split(".")[1];
  if (!payload) return false;
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  try {
    const decoded = JSON.parse(
      Buffer.from(padded, "base64").toString("utf-8"),
    ) as { amr?: Array<{ method: string }> };
    return Array.isArray(decoded.amr)
      ? decoded.amr.some((e) => e?.method === "recovery")
      : false;
  } catch {
    return false;
  }
}

// Read the session. Tries local JWT validation first (fast), falls back
// to the Supabase network call (slow but always works).
//
// RECOVERY SESSION SCOPING (per 06-security-architecture.md §2):
// A password-reset (recovery) session must NOT grant general app access.
// By default, recovery sessions are REJECTED here (return null) so that
// every endpoint protected by requireAuth() returns 401. Only the
// /api/auth/reset-password endpoint opts in via { allowRecovery: true }.
// This closes the bypass where a reset link, when clicked, logs the user
// in without them knowing the password.
export async function getSupabaseSession(options?: {
  allowRecovery?: boolean;
}): Promise<SupabaseSession | null> {
  const allowRecovery = options?.allowRecovery === true;

  // Fast path: local JWT validation (no network round-trip).
  if (isJwtValidationAvailable()) {
    const jwtSession = await getJwtSession();
    if (jwtSession) {
      // Reject recovery sessions unless the caller explicitly allows them.
      if (jwtSession.isRecovery && !allowRecovery) return null;
      return jwtSession;
    }
    // JWT validation failed (expired/invalid) - fall through to getUser()
    // which will refresh the session if possible.
  }

  if (!isSupabaseConfigured()) return null;
  const supabase = await createSupabaseServerClient();
  // getSession() reads the cookie locally (no network) to get the
  // access_token for AMR extraction. getUser() validates the token
  // server-side. We need both: getUser() for auth, getSession() for AMR.
  const { data: sessData } = await supabase.auth.getSession();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  // Extract the AMR from the access token to detect recovery sessions.
  // The token's signature was already validated by getUser() above, so
  // reading the AMR here is safe (no forgery risk).
  const accessToken = sessData.session?.access_token;
  const isRecovery = accessToken ? decodeAmrFromToken(accessToken) : false;
  if (isRecovery && !allowRecovery) return null;

  return {
    authUid: data.user.id,
    email: data.user.email ?? "",
    isRecovery,
  };
}

// Resolve the current account from the session.
// Uses a two-tier cache (Redis + in-memory) to avoid DB queries.
//
// options.allowRecovery: set true ONLY for /api/auth/reset-password. All
// other callers use the default (false) which rejects recovery sessions.
//
// MFA ENFORCEMENT (per 06-security-architecture.md §2 "defense in depth"):
// When the resolved account has mfaEnabled === true, this function ALSO
// requires a valid ng_mfa_verified cookie (JWT signed with
// SUPABASE_JWT_SECRET, bound to account.id). If the cookie is missing or
// invalid, the function returns null - the caller (requireAuth) treats
// the request as unauthenticated (fail closed). The cookie is set by
// /api/auth/mfa/login-verify after the user submits a correct TOTP /
// backup code at sign-in. The MFA gate runs AFTER the cache lookup so
// the cache (keyed by authUid) can stay warm across requests that share
// the same browser session.
export async function getCurrentAccountSupabase(options?: {
  allowRecovery?: boolean;
}): Promise<ApiAccount | null> {
  const session = await getSupabaseSession(options);
  if (!session) return null;

  // NOTE: we do NOT cache recovery sessions, because the cache key is just
  // authUid and a recovery session must not be reusable as a normal session
  // by a later (non-allowRecovery) caller.
  //
  // MFA GATE EXEMPTION (recovery only): the MFA gate is intentionally NOT
  // applied here. A recovery session exists ONLY because the user clicked
  // a password-reset link from their inbox - they are, by definition,
  // unable to complete a login flow (they forgot the password). Requiring
  // ng_mfa_verified here deadlocks every MFA-enabled user out of password
  // reset forever ("invalid token" loop). This is safe because:
  //   1. Recovery sessions are rejected by every OTHER caller (default
  //      allowRecovery=false returns null above), so this exemption can
  //      only ever be observed by /api/auth/reset-password.
  //   2. reset-password itself re-verifies the recovery AMR claim and
  //      signs the session out after the update.
  //   3. The password change does NOT bypass MFA: the login route still
  //      challenges with TOTP after the password is reset.
  if (session.isRecovery) {
    const account = await resolveAccountFromDb(
      session.authUid,
      /* cacheResult */ false,
    );
    return account;
  }

  // Check the unified cache (Redis first, then in-memory).
  const cached = await getAccountCache(session.authUid);
  if (cached !== undefined) {
    return applyMfaGate(cached);
  }

  const result = await resolveAccountFromDb(
    session.authUid,
    /* cacheResult */ true,
  );
  return applyMfaGate(result);
}

// ---- MFA gate ----
// If the account has MFA enabled, require a valid ng_mfa_verified cookie
// bound to account.id. Returns null (fail closed) on:
//   - missing cookie
//   - tampered/expired JWT
//   - subject mismatch (cookie belongs to a different account)
// Otherwise returns the account unchanged.
//
// This runs on EVERY requireAuth-protected request, so it must be cheap.
// verifyMfaVerified is a local jose HS256 verify (~0.1ms).
async function applyMfaGate(
  account: ApiAccount | null,
): Promise<ApiAccount | null> {
  if (!account) return null;
  if (!account.mfaEnabled) return account;
  try {
    const cookieStore = await cookies();
    const cookie = cookieStore.get(MFA_VERIFIED_COOKIE)?.value;
    if (!cookie) return null;
    const ok = await verifyMfaVerified(cookie, account.id);
    return ok ? account : null;
  } catch {
    return null;
  }
}

// Fetch the account from the DB by authUid, with P2022-safe fallback for
// migration 0017 (is_deactivated column). When cacheResult is true, the
// result (including null) is written to the Redis+in-memory cache so
// subsequent requests skip the DB. Recovery sessions pass cacheResult=false
// to avoid poisoning the cache with a session-scoped identity.
//
// Also selects mfaEnabled / mfaEnabledAt so the MFA gate in
// getCurrentAccountSupabase can read it from the cache without a re-query.
async function resolveAccountFromDb(
  authUid: string,
  cacheResult: boolean,
): Promise<ApiAccount | null> {
  // Safe: degrades gracefully if migration 0017 (is_deactivated) not applied.
  let account: {
    id: string;
    email: string;
    fullName: string;
    role: string;
    status: string;
    studentId: number | null;
    program: string | null;
    section: string | null;
    organizationName: string | null;
    year: number | null;
    lastLoginAt: Date | null;
    isDeactivated?: boolean;
    mfaEnabled?: boolean;
    mfaEnabledAt?: Date | null;
  } | null = null;

  try {
    account = await db.account.findFirst({
      where: { supabaseAuthUid: authUid },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        status: true,
        studentId: true,
        program: true,
        section: true,
        organizationName: true,
        year: true,
        lastLoginAt: true,
        isDeactivated: true,
        mfaEnabled: true,
        mfaEnabledAt: true,
      },
    });
  } catch (e) {
    // P2022: a column is missing (migration 0017 or MFA migration not
    // applied). Fall back to the bare schema. MFA fields default to
    // undefined on the ApiAccount, which the gate treats as "not enabled".
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code: string }).code === "P2022"
    ) {
      account = await db.account.findFirst({
        where: { supabaseAuthUid: authUid },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          status: true,
          studentId: true,
          program: true,
          section: true,
          organizationName: true,
          year: true,
          lastLoginAt: true,
        },
      });
    } else {
      throw e;
    }
  }

  // Reject deactivated accounts (soft-deleted).
  const result: ApiAccount | null =
    account && account.status === "ACTIVE" && !account.isDeactivated
      ? {
          ...account,
          role: account.role as ApiAccount["role"],
          lastLoginAt: account.lastLoginAt
            ? account.lastLoginAt.toISOString()
            : null,
          mfaEnabled: account.mfaEnabled ?? false,
          mfaEnabledAt: account.mfaEnabledAt
            ? account.mfaEnabledAt.toISOString()
            : null,
        }
      : null;

  if (cacheResult) {
    // Cache the result (including nulls, so we don't re-query for invalid accounts).
    await setAccountCache(authUid, result, 30_000).catch(() => {});
  }

  return result;
}
