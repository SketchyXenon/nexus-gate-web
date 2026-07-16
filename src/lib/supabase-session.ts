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
import { isDevAuthMode, getDevSessionAccountId } from "@/lib/dev-auth";

export interface SupabaseSession {
  authUid: string;
  email: string;
}

// ---- Account cache (30s TTL, bounded LRU) ----
// Caches the account lookup by supabaseAuthUid to avoid a DB query on
// every API request. The cache is in-memory (per serverless instance).
// Status changes (suspend/activate) take effect within 30s.
// Bounded to ACCOUNT_CACHE_MAX entries (LRU eviction) to prevent unbounded
// memory growth from attacker-supplied fake session tokens.
const ACCOUNT_CACHE_TTL_MS = 30_000;
const ACCOUNT_CACHE_MAX = 2_000;
interface AccountCacheEntry {
  account: ApiAccount | null;
  expiresAt: number;
}
const accountCache = new Map<string, AccountCacheEntry>();

// Clear the cache for a specific user (called when account is updated).
export function invalidateAccountCache(authUid: string): void {
  accountCache.delete(authUid);
}

// Evict expired entries and enforce the max-size bound. Called on every
// cache write. Uses Map insertion-order iteration for LRU eviction (oldest
// entries are evicted first — Map preserves insertion order in JS).
function evictAccountCache(): void {
  // First pass: drop expired entries.
  const now = Date.now();
  for (const [key, entry] of accountCache) {
    if (entry.expiresAt <= now) {
      accountCache.delete(key);
    }
  }
  // Second pass: if still over the limit, evict oldest by insertion order.
  while (accountCache.size > ACCOUNT_CACHE_MAX) {
    const oldest = accountCache.keys().next().value;
    if (oldest === undefined) break;
    accountCache.delete(oldest);
  }
}

// Read the session. In production this is the Supabase Auth cookie.
// In dev (no Supabase configured), falls back to the dev-mode cookie.
export async function getSupabaseSession(): Promise<SupabaseSession | null> {
  // Dev-mode fallback: use the signed cookie when Supabase isn't configured.
  if (isDevAuthMode()) {
    const accountId = await getDevSessionAccountId();
    if (!accountId) return null;
    return { authUid: accountId, email: "" };
  }

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
  // In dev mode, authUid is the account ID; in production it's the
  // Supabase auth UID. Look up by the right field.
  const account = isDevAuthMode()
    ? await db.account.findUnique({
        where: { id: session.authUid },
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
      })
    : await db.account.findFirst({
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

  // Reject deactivated accounts (soft-deleted). They cannot access any API.
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
  evictAccountCache();
  accountCache.set(session.authUid, {
    account: result,
    expiresAt: Date.now() + ACCOUNT_CACHE_TTL_MS,
  });

  return result;
}
