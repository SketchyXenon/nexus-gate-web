// ====================================================================
// Nexus Gate - Shared Redis Client (Aiven / standard TCP Redis)
//
// Aiven Redis is a standard TCP Redis (rediss:// = TLS). Unlike Upstash's
// REST API, it uses a persistent connection that must be pooled + reused
// across requests. On Vercel (serverless) we cache the client on
// globalThis so warm instances reuse ONE connection pool instead of
// opening a new one per request (the historical serverless
// connection-exhaustion bug).
//
// Graceful degradation: if REDIS_URL is not set, getRedis() returns null
// and callers fall back to in-memory (dev) or fail-closed (sensitive
// presets). This keeps local dev zero-config.
//
// PRODUCTION INCIDENT (2026-11-02) - WHY THE FAIL-FAST OPTIONS EXIST:
// When the Redis host is unreachable (network blip / provider outage /
// wrong region), a TCP connect fails with ETIMEDOUT only after the OS
// connect timeout (~20-130s). ioredis's DEFAULTS made this catastrophic
// on Vercel:
//   - enableOfflineQueue (default true): every command issued while the
//     client is still "connecting" is QUEUED, not rejected. The queue
//     only drains once the connection is ready - which never happens.
//   - connectTimeout (default 10s) + retryStrategy (default: retry
//     forever): the client kept re-attempting the connect for minutes.
//   Net effect: the first rate-limit call inside /api/auth/login never
//   resolved, the function hit Vercel's 15s wall -> 504 for EVERY user.
// The fix below bounds every failure mode:
//   1. connectTimeout: 3_000  - TCP+TLS handshake capped at 3s.
//   2. enableOfflineQueue: false - commands issued while disconnected
//      REJECT immediately instead of queueing (callers degrade to
//      in-memory; see rate-limit.ts / account-cache.ts).
//   3. retryStrategy capped at 3 attempts (~2s of backoff total).
//   4. Circuit breaker: any connect-level error opens the breaker for
//      BREAKER_COOLDOWN_MS (30s). isRedisAvailable() returns false while
//      open, so subsequent requests skip Redis INSTANTLY (no 3s connect
//      penalty per request) until the cooldown elapses and the client
//      is allowed to probe again.
//   5. withRedisTimeout(): per-operation deadline (1.5s) so a stall on
//      an ESTABLISHED connection (dead socket, no RST) can't hang a
//      request either. Callers catch RedisTimeoutError and degrade.
//   6. SELF-HEALING (hardening pass 2026-11-02): when retryStrategy
//      gives up, ioredis enters the terminal "end" state and NEVER
//      reconnects on its own - previously the cached client stayed dead
//      for the life of the instance, permanently downgrading that
//      instance to in-memory rate limiting. isRedisAvailable() now
//      detects the "end" state, kicks a manual client.connect() in the
//      background, and reports unavailable until the connection (or the
//      breaker cooldown) resolves. Redis outages now RECOVER without an
//      instance recycle.
// ====================================================================

import "server-only";
import RedisLib from "ioredis";
import type Redis from "ioredis";

const SCHEMA_CACHE_KEY = "redis-v3-fail-fast";

// Circuit breaker: how long a connect-level failure blocks ALL Redis
// usage on this instance. 30s matches typical transient network blips;
// after it elapses the next request pays at most one 3s connect probe.
const BREAKER_COOLDOWN_MS = 30_000;

// Per-operation deadline for withRedisTimeout(). Redis round-trips on a
// healthy connection take 1-5ms; 1.5s is ~300x headroom while still
// leaving the Vercel function budget untouched.
export const REDIS_OP_TIMEOUT_MS = 1_500;

const globalWithRedis = globalThis as unknown as {
  __redisCacheKey?: string;
  __redisClient?: Redis | null;
  __redisUnhealthyUntil?: number;
};

let initError: Error | null = null;

// Circuit-breaker state (per instance, on globalThis so HMR keeps it).
function unhealthyUntil(): number {
  return globalWithRedis.__redisUnhealthyUntil ?? 0;
}

/**
 * Opens the circuit breaker for BREAKER_COOLDOWN_MS. Called by the
 * client's error handler on connect-level failures; exported so callers
 * that observe a RedisTimeoutError can trip it too (a stalled command
 * is evidence the connection is dead even if no error event fired yet).
 */
export function markRedisUnhealthy(): void {
  globalWithRedis.__redisUnhealthyUntil = Date.now() + BREAKER_COOLDOWN_MS;
}

/** True when a connect-level failure recently happened (breaker open). */
function isBreakerOpen(): boolean {
  return Date.now() < unhealthyUntil();
}

// Reconnect bookkeeping. A manual client.connect() is fire-and-forget:
// the flag prevents N concurrent requests from each calling connect()
// on the same dead client (ioredis throws "Cannot connect while
// connecting" if overlapping).
let reviveInFlight = false;

/**
 * HARDENING (pass 2026-11-02): ioredis stops retrying forever once
 * retryStrategy returns null - the client sits in the terminal "end"
 * state and every command rejects with "Stream isn't writeable" /
 * "Connection is closed". Without this, a single >3s Redis outage
 * permanently degraded the instance (cross-instance rate limiting and
 * the shared account cache silently lost until the lambda recycled).
 *
 * Kicks ONE background client.connect() and reports nothing - the
 * caller (isRedisAvailable) already decided to degrade this request.
 * On success the client returns to "ready" and Redis is usable again;
 * on failure the breaker opens so callers keep skipping Redis until
 * the next probe after the cooldown.
 */
function reviveDeadClient(): void {
  const client = globalWithRedis.__redisClient;
  if (!client || client.status !== "end" || reviveInFlight) return;
  reviveInFlight = true;
  console.warn(
    "[redis] client in terminal 'end' state - attempting background reconnect",
  );
  void Promise.resolve()
    .then(() => client.connect())
    .then(() => {
      console.warn("[redis] background reconnect succeeded - Redis recovered");
    })
    .catch((err: unknown) => {
      // Stay degraded: open the breaker so callers skip Redis until the
      // next probe after the cooldown (they would otherwise pay a
      // failing connect attempt on every request).
      markRedisUnhealthy();
      console.error(
        "[redis] background reconnect failed - breaker re-opened:",
        err instanceof Error ? err.message : String(err),
      );
    })
    .finally(() => {
      reviveInFlight = false;
    });
}

// Errors that indicate the CONNECTION layer is broken (as opposed to a
// one-off command failure). Any of these opens the breaker.
const CONNECT_ERROR_PATTERNS = [
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "connect timeout",
  "Stream isn't writeable", // enableOfflineQueue=false rejection while down
  "Connection is closed",
];

function isConnectLevelError(msg: string): boolean {
  const m = msg.toLowerCase();
  return CONNECT_ERROR_PATTERNS.some((p) => m.includes(p.toLowerCase()));
}

function isRedisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL);
}

// Lazily create + cache the client. Returns null if REDIS_URL is unset or
// the connection fails on first import (e.g. bad URL). Callers MUST handle
// null by falling back to in-memory.
function createClient(): Redis | null {
  if (!isRedisConfigured()) return null;
  try {
    const url = process.env.REDIS_URL!;
    // Aiven URLs look like: rediss://default:PASSWORD@HOST:PORT
    // (rediss:// = TLS, which Aiven enforces). ioredis parses the URL and
    // auto-enables TLS for the rediss:// scheme.
    let authFailed = false;
    const client = new RedisLib(url, {
      // On serverless (Vercel), retrying a request whose Redis call already
      // failed wastes the function's time budget. 0 means "fail fast to the
      // caller's catch block" - rate-limit/account-cache then degrade.
      maxRetriesPerRequest: 0,
      enableReadyCheck: true,
      // INCIDENT FIX: reject commands issued while disconnected instead of
      // queueing them until (never) reconnect. This is what turns the
      // 15s hang + 504 into an instant degradation to in-memory.
      enableOfflineQueue: false,
      // INCIDENT FIX: cap the TCP+TLS handshake at 3s (default 10s, and
      // the default retryStrategy would re-attempt it up to 20x).
      connectTimeout: 3_000,
      // Cap reconnect attempts so a misconfigured password (WRONGPASS) or a
      // hard-down Redis does NOT spam retries forever. 3 attempts ~2s of
      // backoff, then stop until the next request triggers a retry.
      retryStrategy: (times) => {
        // Stop reconnecting after 3 attempts OR if auth already failed
        // (a wrong password won't fix itself by retrying).
        if (authFailed || times > 3) return null;
        return Math.min(times * 200, 1_000);
      },
      // Reconnect only on transient errors (READONLY = failover), NOT on auth.
      reconnectOnError(err) {
        const msg = err.message || "";
        if (
          msg.includes("WRONGPASS") ||
          msg.includes("NOAUTH") ||
          msg.includes("invalid username-password")
        ) {
          authFailed = true;
          return false; // do NOT reconnect on auth errors
        }
        return msg.includes("READONLY");
      },
    });
    client.on("error", (err) => {
      const msg = err.message || "";
      // Mark auth as permanently failed so retryStrategy stops hammering.
      if (
        msg.includes("WRONGPASS") ||
        msg.includes("NOAUTH") ||
        msg.includes("invalid username-password")
      ) {
        authFailed = true;
        // Disconnect the broken client so it stops retrying. ioredis's
        // disconnect() returns void (synchronous), so wrap in try/catch.
        try {
          client.disconnect();
        } catch {
          // ignore - already disconnecting
        }
        initError = err;
        console.error(
          "[redis] AUTH FAILED - disabling Redis. Check REDIS_URL password. App degrades to in-memory.",
        );
        return;
      }
      // INCIDENT FIX: connect-level failures open the circuit breaker so
      // callers skip Redis instantly (isRedisAvailable() -> false) instead
      // of paying a 3s connect probe on every request during an outage.
      if (isConnectLevelError(msg)) {
        markRedisUnhealthy();
      }
      // Log but don't throw - the app degrades to in-memory fallback.
      console.error("[redis] client error:", msg);
    });
    return client;
  } catch (e) {
    initError = e instanceof Error ? e : new Error(String(e));
    console.error("[redis] failed to create client:", initError.message);
    return null;
  }
}

// Singleton: reuse across HMR (dev) and warm instances (prod).
let cachedClient: Redis | null | undefined;
if (
  globalWithRedis.__redisClient &&
  globalWithRedis.__redisCacheKey === SCHEMA_CACHE_KEY
) {
  cachedClient = globalWithRedis.__redisClient;
} else {
  cachedClient = createClient();
  globalWithRedis.__redisClient = cachedClient;
  globalWithRedis.__redisCacheKey = SCHEMA_CACHE_KEY;
}

// Export the client (null when unconfigured or init failed).
export const redis: Redis | null = cachedClient ?? null;

/**
 * Availability gate for ALL Redis consumers. False when:
 *   - REDIS_URL is unset (dev / zero-config),
 *   - client creation failed (bad URL),
 *   - auth permanently failed (WRONGPASS - client disconnected), or
 *   - the circuit breaker is open (recent connect-level failure).
 * Callers fall back to in-memory on false - they must never await Redis
 * while this gate is closed.
 */
export function isRedisAvailable(): boolean {
  if (redis === null || initError !== null || isBreakerOpen()) return false;
  // Terminal "end" state (retryStrategy exhausted): ioredis never
  // auto-reconnects from here. Trigger one background reconnect and
  // degrade THIS request to in-memory; once connect() resolves the
  // client is "ready" again and later requests use Redis normally.
  if (redis.status === "end") {
    reviveDeadClient();
    return false;
  }
  return true;
}

export function getRedisInitError(): Error | null {
  return initError;
}

// --------------------------------------------------------------------
// Bounded-timeout helper (per-operation deadline)
// --------------------------------------------------------------------

/** Thrown by withRedisTimeout when an operation misses its deadline. */
export class RedisTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Redis operation timed out after ${timeoutMs}ms`);
    this.name = "RedisTimeoutError";
  }
}

/**
 * Runs `op` with a hard deadline. A healthy Redis round-trip takes
 * single-digit milliseconds; this guards the rare "socket established
 * but silently dead" case where ioredis has no connect error to emit
 * and the command would otherwise hang until the OS gives up.
 *
 * On timeout it rejects with RedisTimeoutError (NOT null - several
 * commands legitimately return null for "key not found", and callers
 * must be able to distinguish a miss from a stall). Callers catch it
 * and degrade to in-memory, exactly like any other Redis error.
 */
export async function withRedisTimeout<T>(
  op: () => Promise<T>,
  timeoutMs: number = REDIS_OP_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RedisTimeoutError(timeoutMs)),
          timeoutMs,
        );
        // Don't hold the process open just for the deadline timer.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
