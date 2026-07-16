// ====================================================================
// Nexus Gate - Unified Account Cache (Redis + In-Memory)
//
// Two-tier cache for account lookups:
//   1. In-memory (0ms, per-instance, 30s TTL)
//   2. Upstash Redis (1-2ms, shared across all Vercel instances, 30s TTL)
//
// Read path: check in-memory, then Redis, then DB (caller's responsibility).
// Write path: write to both in-memory and Redis.
// Invalidation: delete from both.
//
// Graceful degradation: if Upstash isn't configured, uses in-memory only.
// ====================================================================

import "server-only";
import type { ApiAccount } from "@/lib/api";

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

let redisClient: import("@upstash/redis").Redis | null = null;
let redisChecked = false;

async function getRedis() {
  if (redisChecked) return redisClient;
  redisChecked = true;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = await import("@upstash/redis");
    redisClient = new Redis({ url, token });
    return redisClient;
  } catch {
    return null;
  }
}

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

  // Layer 2: Redis (shared across instances).
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await redis.get<string>(`${REDIS_PREFIX}${authUid}`);
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
      // Redis error - fall through to undefined (cache miss).
    }
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
    const redis = await getRedis();
    if (redis) {
      await redis.del(`${REDIS_PREFIX}${authUid}`).catch(() => {});
    }
    return;
  }

  // Write to in-memory.
  memEvict();
  memCache.set(authUid, {
    account,
    expiresAt: Date.now() + ttlMs,
  });

  // Write to Redis (shared across instances).
  const redis = await getRedis();
  if (redis) {
    try {
      // Store null as the string "null" (negative cache), objects as JSON.
      const value = account === null ? "null" : JSON.stringify(account);
      await redis.set(`${REDIS_PREFIX}${authUid}`, value, { ex: REDIS_TTL_S });
    } catch {
      // Non-critical - in-memory cache still works.
    }
  }
}
