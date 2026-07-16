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

export interface SupabaseSession {
  authUid: string;
  email: string;
}

// Clear the cache for a specific user (called when account is updated).
export function invalidateAccountCache(authUid: string): void {
  // Delegate to the unified cache module (handles both Redis + in-memory).
  void setAccountCache(authUid, null, 0).catch(() => {});
}

// Read the session. Tries local JWT validation first (fast), falls back
// to the Supabase network call (slow but always works).
export async function getSupabaseSession(): Promise<SupabaseSession | null> {
  // Fast path: local JWT validation (no network round-trip).
  if (isJwtValidationAvailable()) {
    const jwtSession = await getJwtSession();
    if (jwtSession) return jwtSession;
    // JWT validation failed (expired/invalid) - fall through to getUser()
    // which will refresh the session if possible.
  }

  if (!isSupabaseConfigured()) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { authUid: data.user.id, email: data.user.email ?? "" };
}

// Resolve the current account from the session.
// Uses a two-tier cache (Redis + in-memory) to avoid DB queries.
export async function getCurrentAccountSupabase(): Promise<ApiAccount | null> {
  const session = await getSupabaseSession();
  if (!session) return null;

  // Check the unified cache (Redis first, then in-memory).
  const cached = await getAccountCache(session.authUid);
  if (cached !== undefined) return cached;

  // Cache miss - fetch from DB.
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
  } | null = null;

  try {
    account = await db.account.findFirst({
      where: { supabaseAuthUid: session.authUid },
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
      },
    });
  } catch (e) {
    // P2022: is_deactivated column missing (migration 0017 not applied).
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code: string }).code === "P2022"
    ) {
      account = await db.account.findFirst({
        where: { supabaseAuthUid: session.authUid },
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
  const result =
    account && account.status === "ACTIVE" && !account.isDeactivated
      ? {
          ...account,
          role: account.role as ApiAccount["role"],
          lastLoginAt: account.lastLoginAt
            ? account.lastLoginAt.toISOString()
            : null,
        }
      : null;

  // Cache the result (including nulls, so we don't re-query for invalid accounts).
  await setAccountCache(session.authUid, result, 30_000).catch(() => {});

  return result;
}
