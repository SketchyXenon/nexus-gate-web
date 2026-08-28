// Nexus Gate - Session Management (Supabase Auth).
// Single session system: Supabase Auth cookie. The old dual system
// (custom JWT + NextAuth) has been replaced - see supabase-session.ts.

import { db } from "@/lib/db";
import {
  getCurrentAccountSupabase,
  getSupabaseSession,
  invalidateAccountCache,
} from "@/lib/supabase-session";
import type { AccessTokenPayload } from "@/lib/auth";
import { cookies } from "next/headers";
import { MFA_VERIFIED_COOKIE, verifyMfaVerified } from "@/lib/mfa";

// Read the current session from the Supabase Auth cookie.
//
// MFA ENFORCEMENT (per 06-security-architecture.md §2 "defense in depth"):
// After the account is loaded, IF account.mfaEnabled === true, this function
// ALSO requires a valid ng_mfa_verified cookie (JWT, signed with
// SUPABASE_JWT_SECRET, bound to account.id). If the cookie is missing or
// invalid, the function returns null - the caller treats the request as
// unauthenticated (fail closed). The current requireAuth path goes through
// getCurrentAccount() → getCurrentAccountSupabase() which applies the same
// gate; this function mirrors it so any direct caller of getSession() is
// also protected.
export async function getSession(): Promise<AccessTokenPayload | null> {
  const supa = await getSupabaseSession();
  if (!supa) return null;
  const account = await db.account.findFirst({
    where: { supabaseAuthUid: supa.authUid },
    select: {
      id: true,
      role: true,
      status: true,
      mfaEnabled: true,
    },
  });
  if (!account) return null;
  // MFA gate: account.mfaEnabled true + no valid ng_mfa_verified = deny.
  if (account.mfaEnabled) {
    try {
      const cookieStore = await cookies();
      const cookie = cookieStore.get(MFA_VERIFIED_COOKIE)?.value;
      if (!cookie) return null;
      const ok = await verifyMfaVerified(cookie, account.id);
      if (!ok) return null;
    } catch {
      return null;
    }
  }
  return {
    sub: account.id,
    role: account.role,
    status: account.status,
    type: "access",
  };
}

// Get the full account record for the current session.
// Always fetches fresh from DB so status changes (suspend) take effect
// immediately, not when the token expires.
//
// MFA enforcement is applied inside getCurrentAccountSupabase (the account
// loader). When that returns null for an MFA-enabled account without a
// valid ng_mfa_verified cookie, this returns null too - which means
// requireAuth() will return 401 (fail closed).
export async function getCurrentAccount() {
  return getCurrentAccountSupabase();
}

// Re-export so callers that mutate account.mfaEnabled can invalidate the
// cached ApiAccount (which carries mfaEnabled) without importing from
// supabase-session.ts directly.
export { invalidateAccountCache };
