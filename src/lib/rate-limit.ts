// ====================================================================
// Nexus Gate - Rate Limiter
// Production: Aiven Redis (standard TCP, rediss://) | Dev: in-memory Map
//
// Uses an atomic Lua sliding-window algorithm (ZSET + PEXPIRE) that runs
// entirely inside Redis - no TOCTOU window between count and increment.
// Works with ANY standard Redis (Aiven, ElastiCache, self-hosted), not
// just Upstash's REST API.
// ====================================================================

import "server-only";
import { redis, isRedisAvailable } from "@/lib/redis";

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

const PRESETS: Record<string, RateLimitConfig> = {
  login: { maxRequests: 5, windowMs: 60_000 },
  register: { maxRequests: 5, windowMs: 60_000 },
  otp: { maxRequests: 5, windowMs: 60_000 },
  check: { maxRequests: 15, windowMs: 60_000 },
  scan: { maxRequests: 60, windowMs: 60_000 },
  api: { maxRequests: 120, windowMs: 60_000 },
  scanAccount: { maxRequests: 30, windowMs: 60_000 },
  apiAccount: { maxRequests: 100, windowMs: 60_000 },
  // Passkey flows. Options is cheap (no crypto), so allow more per-IP.
  passkeyOptions: { maxRequests: 30, windowMs: 60_000 },
  // Verify is expensive (Ed25519 + Supabase round-trip).
  passkeyVerify: { maxRequests: 10, windowMs: 60_000 },
  // Passkey registration (Ed25519 key gen + DB write). Tighter than verify
  // because it creates persistent credentials - an attacker hammering this
  // could pollute the device_keys table.
  passkeyRegister: { maxRequests: 10, windowMs: 60_000 },
  // Per-account checkpoint applied AFTER credential lookup identifies the
  // account. This is the "user_id" rate-limit checkpoint: even if many IPs
  // submit forged assertions for one credential, the account is throttled.
  passkeyAccount: { maxRequests: 5, windowMs: 60_000 },
  // Per-account checkpoint for password login (applied after email lookup,
  // on top of the per-email limit). Defends against distributed brute force
  // where an attacker rotates IPs but targets one account.
  loginAccount: { maxRequests: 5, windowMs: 60_000 },
  // Admin destructive mutations (account create/delete). The default
  // apiAccount (100/min) is too permissive for operations that create or
  // destroy user accounts. 20/min is plenty for legitimate admin work.
  adminMutation: { maxRequests: 20, windowMs: 60_000 },
  // Whitelist bulk import (up to 5000 rows per request). The default
  // apiAccount (100/min) would allow 100 * 5000 = 500k row-updates/min,
  // an easy DoS vector. 3/min is enough for periodic roster refreshes.
  whitelistImport: { maxRequests: 3, windowMs: 60_000 },
  // Whitelist file upload + heavy parsing (Excel/PDF/DOCX, up to 10MB).
  // Tighter than the JSON import because parsing is CPU-intensive.
  whitelistImportFile: { maxRequests: 5, windowMs: 60_000 },
};

export type RateLimitPreset = keyof typeof PRESETS;

// Sensitive presets where failing OPEN on Redis error would let an
// attacker bypass brute-force protection by DDoSing Redis. These fail
// CLOSED (deny the request) when Redis is unreachable.
const SENSITIVE_PRESETS: ReadonlySet<RateLimitPreset> = new Set([
  "login",
  "register",
  "otp",
  "passkeyVerify",
  "passkeyRegister",
  "passkeyAccount",
  "loginAccount",
  "adminMutation",
  "whitelistImport",
  "whitelistImportFile",
]);

// ---- In-memory backend (dev fallback) ----
interface Bucket {
  count: number;
  windowStart: number;
}
const memoryBuckets = new Map<string, Bucket>();

// Hard cap on the number of tracked keys. Without this, an attacker rotating
// IPs (or a NAT'd campus with thousands of students) grows the Map unboundedly
// inside a 2-minute window - a memory-exhaustion DoS vector on single-instance
// deployments (Vercel dev, the sandbox, any non-serverless host). The cap is
// generous: 10k keys * ~40 bytes each ~= 400KB. When exceeded, the oldest
// entries (Map preserves insertion order) are evicted, mirroring the LRU
// strategy in account-cache.ts. Evicted keys simply reset their counter on
// the next request, which is the safe direction (allow rather than deny).
const MEMORY_MAX_KEYS = 10_000;

function evictExpiredAndCap(): void {
  const cutoff = Date.now() - 2 * 60_000;
  for (const [key, bucket] of memoryBuckets) {
    if (bucket.windowStart < cutoff) memoryBuckets.delete(key);
  }
  // LRU-style cap: drop oldest entries (first inserted) until under the limit.
  while (memoryBuckets.size > MEMORY_MAX_KEYS) {
    const oldest = memoryBuckets.keys().next().value;
    if (oldest === undefined) break;
    memoryBuckets.delete(oldest);
  }
}

if (typeof setInterval !== "undefined") {
  setInterval(() => {
    evictExpiredAndCap();
  }, 2 * 60_000).unref?.();
}

function memoryLimit(key: string, preset: RateLimitPreset) {
  const config = PRESETS[preset];
  const now = Date.now();
  let bucket = memoryBuckets.get(key);
  if (!bucket) {
    // Bound the map size before inserting a new key.
    if (memoryBuckets.size >= MEMORY_MAX_KEYS) evictExpiredAndCap();
    bucket = { count: 0, windowStart: now };
    memoryBuckets.set(key, bucket);
  }
  if (now - bucket.windowStart >= config.windowMs) {
    bucket.count = 0;
    bucket.windowStart = now;
  }
  if (bucket.count < config.maxRequests) {
    bucket.count++;
    return {
      allowed: true,
      remaining: config.maxRequests - bucket.count,
      retryAfterMs: 0,
    };
  }
  return {
    allowed: false,
    remaining: 0,
    retryAfterMs: config.windowMs - (now - bucket.windowStart),
  };
}

// ---- Redis backend (atomic Lua sliding window) ----
//
// The Lua script runs entirely inside Redis (single-threaded, atomic). It:
//   1. Removes ZSET members whose score (timestamp) is older than now-window.
//   2. Counts remaining members.
//   3. If count >= max: returns [0, 0, retryMs] (denied + retry-after).
//   4. Else: adds the request id to the ZSET, sets PEXPIRE, returns
//      [1, remaining, 0] (allowed).
//
// This is the standard sliding-window-log algorithm. It's more accurate
// than a fixed window (no burst at boundaries) and atomic without locks.
// The request id (crypto-random) ensures distinct concurrent requests in
// the same millisecond don't collide in the ZSET.
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local maxreq = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local reqid = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= maxreq then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldest_ts = tonumber(oldest[2]) or now
  local retry = window - (now - oldest_ts)
  if retry < 0 then retry = 0 end
  return {0, 0, retry}
end
redis.call('ZADD', key, now, reqid)
redis.call('PEXPIRE', key, window)
return {1, maxreq - count - 1, 0}
`;

// Cache the SHA1 of the loaded script so we don't re-EVAL (text) on every
// call - EVALSHA is one round-trip cheaper and standard practice.
let scriptSha: string | null = null;

async function getScriptSha(): Promise<string | null> {
  if (scriptSha) return scriptSha;
  if (!redis) return null;
  try {
    // ioredis returns RedisReturnType (Buffer | string | null) for SCRIPT LOAD.
    // Cast to string; the SHA1 is always a 40-char hex string.
    const sha = (await redis.script("LOAD", SLIDING_WINDOW_LUA)) as string;
    scriptSha = typeof sha === "string" ? sha : null;
    return scriptSha;
  } catch {
    return null;
  }
}

function randomId(): string {
  // crypto.randomUUID is available in Node 19+ / Edge. Fall back to
  // Math.random for older runtimes (collision probability is negligible
  // for a ZSET member id within a 60s window).
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

async function redisLimit(
  key: string,
  preset: RateLimitPreset,
): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
  const config = PRESETS[preset];
  if (!redis) {
    return { allowed: false, remaining: 0, retryAfterMs: config.windowMs };
  }
  const now = Date.now();
  const reqid = randomId();
  const redisKey = `nexus-gate:${preset}:${key}`;
  const sha = await getScriptSha();
  let result: number[] | null = null;
  try {
    if (sha) {
      // EVALSHA (1 round-trip). Falls back to EVAL on NOSCRIPT error.
      result = (await redis.evalsha(
        sha,
        1,
        redisKey,
        String(config.windowMs),
        String(config.maxRequests),
        String(now),
        reqid,
      )) as number[] | null;
    }
    if (!result) {
      result = (await redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        redisKey,
        String(config.windowMs),
        String(config.maxRequests),
        String(now),
        reqid,
      )) as number[] | null;
    }
  } catch (e) {
    // NOSCRIPT: the script was evicted from Redis's cache. Reload + retry once.
    if (e instanceof Error && /NOSCRIPT/i.test(e.message)) {
      try {
        result = (await redis.eval(
          SLIDING_WINDOW_LUA,
          1,
          redisKey,
          String(config.windowMs),
          String(config.maxRequests),
          String(now),
          reqid,
        )) as number[] | null;
        // Refresh the cached SHA on the next call.
        scriptSha = null;
      } catch (e2) {
        throw e2;
      }
    } else {
      throw e;
    }
  }
  if (!result || result.length < 3) {
    return { allowed: false, remaining: 0, retryAfterMs: config.windowMs };
  }
  return {
    allowed: result[0] === 1,
    remaining: result[1],
    retryAfterMs: result[2],
  };
}

let warningLogged = false;

// ---- Public API ----
export async function rateLimit(
  key: string,
  preset: RateLimitPreset,
): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
  const config = PRESETS[preset];

  if (!isRedisAvailable()) {
    if (process.env.NODE_ENV === "production" && !warningLogged) {
      console.warn(
        "[rate-limit] REDIS_URL not set - using in-memory fallback.",
      );
      warningLogged = true;
    }
    return memoryLimit(key, preset);
  }

  try {
    return await redisLimit(key, preset);
  } catch (e) {
    // On serverless (Vercel) without Redis, in-memory limiting doesn't work
    // (each request hits a different instance). For general API presets we
    // fail OPEN to avoid blocking all users during a Redis outage. For
    // SENSITIVE presets (login, register, passkey) we fail CLOSED - an
    // attacker could otherwise DDoS Redis to bypass brute-force protection.
    const isSensitive = SENSITIVE_PRESETS.has(preset);
    console.error(
      `[rate-limit] Redis error, failing ${isSensitive ? "CLOSED" : "open"}:`,
      e instanceof Error ? e.message : e,
    );
    if (isSensitive) {
      return { allowed: false, remaining: 0, retryAfterMs: config.windowMs };
    }
    return {
      allowed: true,
      remaining: config.maxRequests - 1,
      retryAfterMs: 0,
    };
  }
}

export function rateLimitSync(
  key: string,
  preset: RateLimitPreset,
): { allowed: boolean; remaining: number; retryAfterMs: number } {
  return memoryLimit(key, preset);
}
