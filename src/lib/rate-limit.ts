// ====================================================================
// Nexus Gate — Rate Limiter
// Production: Upstash Redis | Dev: in-memory Map
// ====================================================================

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

const PRESETS: Record<string, RateLimitConfig> = {
  login: { maxRequests: 5, windowMs: 60_000 },
  register: { maxRequests: 5, windowMs: 60_000 },
  otp: { maxRequests: 5, windowMs: 60_000 },
  scan: { maxRequests: 60, windowMs: 60_000 },
  api: { maxRequests: 120, windowMs: 60_000 },
  scanAccount: { maxRequests: 30, windowMs: 60_000 },
  apiAccount: { maxRequests: 100, windowMs: 60_000 },
};

export type RateLimitPreset = keyof typeof PRESETS;

// ---- In-memory backend (dev fallback) ----
interface Bucket {
  count: number;
  windowStart: number;
}
const memoryBuckets = new Map<string, Bucket>();

if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const cutoff = Date.now() - 2 * 60_000;
    for (const [key, bucket] of memoryBuckets) {
      if (bucket.windowStart < cutoff) memoryBuckets.delete(key);
    }
  }, 2 * 60_000).unref?.();
}

function memoryLimit(key: string, preset: RateLimitPreset) {
  const config = PRESETS[preset];
  const now = Date.now();
  let bucket = memoryBuckets.get(key);
  if (!bucket) {
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

// ---- Upstash backend (production) ----
const presetLimiters = new Map<RateLimitPreset, Ratelimit>();
let upstashWarningLogged = false;

function isUpstashConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
  );
}

function getPresetLimiter(preset: RateLimitPreset): Ratelimit | null {
  if (!isUpstashConfigured()) return null;
  const cached = presetLimiters.get(preset);
  if (cached) return cached;
  const config = PRESETS[preset];
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(
      config.maxRequests,
      `${config.windowMs / 1000} s`,
    ),
    prefix: `nexus-gate:${preset}`,
    ephemeralCache: new Map<string, number>(),
  });
  presetLimiters.set(preset, limiter);
  return limiter;
}

// ---- Public API ----
export async function rateLimit(
  key: string,
  preset: RateLimitPreset,
): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
  const config = PRESETS[preset];
  const limiter = getPresetLimiter(preset);

  if (!limiter) {
    if (process.env.NODE_ENV === "production" && !upstashWarningLogged) {
      console.warn(
        "[rate-limit] UPSTASH_REDIS_REST_URL not set — using in-memory fallback.",
      );
      upstashWarningLogged = true;
    }
    return memoryLimit(key, preset);
  }

  try {
    const result = await limiter.limit(key);
    return {
      allowed: result.success,
      remaining: result.remaining,
      retryAfterMs: Math.max(0, result.reset - Date.now()),
    };
  } catch (e) {
    // On serverless (Vercel) without Upstash, in-memory limiting doesn't work
    // (each request hits a different instance). Fail OPEN to avoid blocking
    // all users. Set UPSTASH_REDIS_REST_URL for proper distributed rate limiting.
    console.error("[rate-limit] Upstash error, failing open:", e);
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
