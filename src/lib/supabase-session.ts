// Nexus Gate - Supabase Auth session layer.
// Replaces the old dual system (custom JWT + NextAuth) with one
// Supabase Auth session. Reads the session cookie via @supabase/ssr,
// resolves the Supabase user, then loads the linked accounts row.

import {
  createSupabaseServerClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";
import { db } from "@/lib/db";
import type { ApiAccount } from "@/lib/api";

export interface SupabaseSession {
  authUid: string;
  email: string;
}

// ---- Account cache (30s TTL) ----
// Caches the account lookup by supabaseAuthUid to avoid a DB query on
// every API request. The cache is in-memory (per serverless instance).
// Status changes (suspend/activate) take effect within 30s.
const ACCOUNT_CACHE_TTL_MS = 30_000;
interface AccountCacheEntry {
  account: ApiAccount | null;
  expiresAt: number;
}
const accountCache = new Map<string, AccountCacheEntry>();

// Clear the cache for a specific user (called when account is updated).
export function invalidateAccountCache(authUid: string): void {
  accountCache.delete(authUid);
}

// Read the Supabase session from cookies. Returns null if no session
// or if Supabase isn't configured (dev without env vars).
export async function getSupabaseSession(): Promise<SupabaseSession | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { authUid: data.user.id, email: data.user.email ?? "" };
}

// Resolve the current account from the Supabase session.
// Uses a 30s in-memory cache to avoid a DB query on every request.
// Status changes (suspend) take effect within 30s.
export async function getCurrentAccountSupabase(): Promise<ApiAccount | null> {
  const session = await getSupabaseSession();
  if (!session) return null;

  // Check cache first.
  const cached = accountCache.get(session.authUid);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.account;
  }

  // Cache miss or expired — fetch from DB.
  const account = await db.account.findFirst({
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
    },
  });

  const result =
    account && account.status === "ACTIVE"
      ? { ...account, role: account.role as ApiAccount["role"] }
      : null;

  // Cache the result (including nulls, so we don't re-query for invalid accounts).
  accountCache.set(session.authUid, {
    account: result,
    expiresAt: Date.now() + ACCOUNT_CACHE_TTL_MS,
  });

  return result;
}
