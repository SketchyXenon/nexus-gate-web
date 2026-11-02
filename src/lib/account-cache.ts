// ====================================================================
// Nexus Gate - Unified Account Cache (Redis + In-Memory)
//
// Two-tier cache for account lookups:
//   1. In-memory (0ms, per-instance, 30s TTL)
//   2. Aiven Redis (1-2ms, shared across all Vercel instances, 30s TTL)
//
// Read path: check in-memory, then Redis, then DB (caller's responsibility).
// Write path: write to both in-memory and Redis.
// Invalidation: delete from both.
//
// Graceful degradation: if REDIS_URL isn't configured, uses in-memory only.
// Uses the shared ioredis singleton from @/lib/redis (pooled, serverless-safe).
//
// INCIDENT FIX (2026-11-02): every Redis operation here is wrapped in
// withRedisTimeout (1s) - the account cache sits on the LOGIN and
// session-resolution path, and an unbounded Redis call during an outage
// contributed to the login 504s. A timeout (or any Redis error) now
// behaves like a cache miss: the caller falls through to the DB.
// ====================================================================

import "server-only";
import type { ApiAccount } from "@/lib/api";
import { redis, isRedisAvailable, withRedisTimeout } from "@/lib/redis";

// The account cache serves auth-critical reads - bound it tighter than
// the generic REDIS_OP_TIMEOUT_MS (1.5s): a cache that costs 1.5s is
// worse than no cache at all.
const CACHE_OP_TIMEOUT_MS = 1_000;

// ---- In-memory layer (per-instance) ----
const MEM_TTL_MS = 30_000;
const MEM_MAX = 2_000;
interface MemEntry {
  account: ApiAccount | null;
  expiresAt: number;
}
const memCache = new Map<string, MemEntry>();

function memEvict(): void {
  const now = Date.now();
  for (const [key, entry] of memCache) {
    if (entry.expiresAt <= now) memCache.delete(key);
  }
  while (memCache.size > MEM_MAX) {
    const oldest = memCache.keys().next().value;
    if (oldest === undefined) break;
    memCache.delete(oldest);
  }
}

// ---- Redis layer (shared, optional) ----
const REDIS_PREFIX = "ng:acct:";
const REDIS_TTL_S = 30;

// ---- Public API ----

// Get a cached account. Returns undefined if not in cache (caller queries DB).
// Returns null if the account was cached as "not found" (negative cache).
export async function getAccountCache(
  authUid: string,
): Promise<ApiAccount | null | undefined> {
  // Layer 1: in-memory (fastest).
  const mem = memCache.get(authUid);
  if (mem && Date.now() < mem.expiresAt) {
    return mem.account;
  }

  // Layer 2: Redis (shared across instances). Bounded: a stalled socket
  // behaves like a miss, never like a hang.
  if (!isRedisAvailable() || !redis) {
    return undefined;
  }
  try {
    const raw = await withRedisTimeout(
      () => redis!.get(`${REDIS_PREFIX}${authUid}`),
      CACHE_OP_TIMEOUT_MS,
    );
    if (raw !== null) {
      const account = raw === "null" ? null : (JSON.parse(raw) as ApiAccount);
      // Populate in-memory for subsequent requests.
      memEvict();
      memCache.set(authUid, {
        account,
        expiresAt: Date.now() + MEM_TTL_MS,
      });
      return account;
    }
  } catch {
    // Redis error/timeout - fall through to undefined (cache miss).
  }

  return undefined;
}

// Set the cache. ttlMs=0 means invalidate (delete).
export async function setAccountCache(
  authUid: string,
  account: ApiAccount | null,
  ttlMs: number,
): Promise<void> {
  if (ttlMs <= 0) {
    // Invalidation.
    memCache.delete(authUid);
    if (isRedisAvailable() && redis) {
      await withRedisTimeout(
        () => redis!.del(`${REDIS_PREFIX}${authUid}`),
        CACHE_OP_TIMEOUT_MS,
      ).catch(() => {});
    }
    return;
  }

  // Write to in-memory.
  memEvict();
  memCache.set(authUid, {
    account,
    expiresAt: Date.now() + ttlMs,
  });

  // Write to Redis (shared across instances). Bounded - a cache write
  // must never hold a request hostage.
  if (isRedisAvailable() && redis) {
    try {
      // Store null as the string "null" (negative cache), objects as JSON.
      const value = account === null ? "null" : JSON.stringify(account);
      // EX = seconds TTL (matches REDIS_TTL_S). ioredis supports the EX option.
      await withRedisTimeout(
        () => redis!.set(`${REDIS_PREFIX}${authUid}`, value, "EX", REDIS_TTL_S),
        CACHE_OP_TIMEOUT_MS,
      );
    } catch {
      // Non-critical - in-memory cache still works.
    }
  }
}
