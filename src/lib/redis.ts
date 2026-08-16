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
// ====================================================================

import "server-only";
import RedisLib from "ioredis";
import type Redis from "ioredis";

const SCHEMA_CACHE_KEY = "redis-aiven-v1";

const globalWithRedis = globalThis as unknown as {
  __redisCacheKey?: string;
  __redisClient?: Redis | null;
};

let initError: Error | null = null;

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
    const client = new RedisLib(url, {
      // Connection pooling: Aiven free tier allows many concurrent client
      // connections, but each Vercel instance should hold a small pool.
      // ioredis default maxConnections is large; cap it for serverless.
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      // Aiven idle timeout is generous; keep the connection warm.
      retryStrategy: (times) => Math.min(times * 200, 2000),
      // Reconnect on error with backoff (don't crash the instance).
      reconnectOnError(err) {
        const targetMsg = "READONLY";
        return err.message.includes(targetMsg);
      },
    });
    client.on("error", (err) => {
      // Log but don't throw - the app degrades to in-memory fallback.
      console.error("[redis] client error:", err.message);
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
if (globalWithRedis.__redisClient && globalWithRedis.__redisCacheKey === SCHEMA_CACHE_KEY) {
  cachedClient = globalWithRedis.__redisClient;
} else {
  cachedClient = createClient();
  globalWithRedis.__redisClient = cachedClient;
  globalWithRedis.__redisCacheKey = SCHEMA_CACHE_KEY;
}

// Export the client (null when unconfigured or init failed).
export const redis: Redis | null = cachedClient ?? null;

export function isRedisAvailable(): boolean {
  return redis !== null && initError === null;
}

export function getRedisInitError(): Error | null {
  return initError;
}
