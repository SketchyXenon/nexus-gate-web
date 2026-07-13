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
  check: { maxRequests: 15, windowMs: 60_000 },
  scan: { maxRequests: 60, windowMs: 60_000 },
  api: { maxRequests: 120, windowMs: 60_000 },
  scanAccount: { maxRequests: 30, windowMs: 60_000 },
  apiAccount: { maxRequests: 100, windowMs: 60_000 },
  // Passkey flows. Options is cheap (no crypto), so allow more per-IP.
  passkeyOptions: { maxRequests: 30, windowMs: 60_000 },
  // Verify is expensive (Ed25519 + Supabase round-trip).
  passkeyVerify: { maxRequests: 10, windowMs: 60_000 },
  // Per-account checkpoint applied AFTER credential lookup identifies the
  // account. This is the "user_id" rate-limit checkpoint: even if many IPs
  // submit forged assertions for one credential, the account is throttled.
  passkeyAccount: { maxRequests: 5, windowMs: 60_000 },
  // Per-account checkpoint for password login (applied after email lookup,
  // on top of the per-email limit). Defends against distributed brute force
  // where an attacker rotates IPs but targets one account.
  loginAccount: { maxRequests: 5, windowMs: 60_000 },
};

export type RateLimitPreset = keyof typeof PRESETS;

// Sensitive presets where failing OPEN on Upstash error would let an
// attacker bypass brute-force protection by DDoSing Upstash. These fail
// CLOSED (deny the request) when Upstash is unreachable.
const SENSITIVE_PRESETS: ReadonlySet<RateLimitPreset> = new Set([
  "login",
  "register",
  "otp",
  "passkeyVerify",
  "passkeyAccount",
  "loginAccount",
]);

// ---- In-memory backend (dev fallback) ----
interface Bucket { count: number; windowStart: number; }
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
  if (!bucket) { bucket = { count: 0, windowStart: now }; memoryBuckets.set(key, bucket); }
  if (now - bucket.windowStart >= config.windowMs) { bucket.count = 0; bucket.windowStart = now; }
  if (bucket.count < config.maxRequests) {
    bucket.count++;
    return { allowed: true, remaining: config.maxRequests - bucket.count, retryAfterMs: 0 };
  }
  return { allowed: false, remaining: 0, retryAfterMs: config.windowMs - (now - bucket.windowStart) };
}

// ---- Upstash backend (production) ----
const presetLimiters = new Map<RateLimitPreset, Ratelimit>();
let upstashWarningLogged = false;

function isUpstashConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function getPresetLimiter(preset: RateLimitPreset): Ratelimit | null {
  if (!isUpstashConfigured()) return null;
  const cached = presetLimiters.get(preset);
  if (cached) return cached;
  const config = PRESETS[preset];
  const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(config.maxRequests, `${config.windowMs / 1000} s`),
    prefix: `nexus-gate:${preset}`,
    ephemeralCache: new Map<string, number>(),
  });
  presetLimiters.set(preset, limiter);
  return limiter;
}

// ---- Public API ----
export async function rateLimit(
  key: string,
  preset: RateLimitPreset
): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
  const config = PRESETS[preset];
  const limiter = getPresetLimiter(preset);

  if (!limiter) {
    if (process.env.NODE_ENV === "production" && !upstashWarningLogged) {
      console.warn("[rate-limit] UPSTASH_REDIS_REST_URL not set — using in-memory fallback.");
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
    // (each request hits a different instance). For general API presets we
    // fail OPEN to avoid blocking all users during an Upstash outage. For
    // SENSITIVE presets (login, register, passkey) we fail CLOSED — an
    // attacker could otherwise DDoS Upstash to bypass brute-force protection.
    const isSensitive = SENSITIVE_PRESETS.has(preset);
    console.error(
      `[rate-limit] Upstash error, failing ${isSensitive ? "CLOSED" : "open"}:`,
      e,
    );
    if (isSensitive) {
      return { allowed: false, remaining: 0, retryAfterMs: config.windowMs };
    }
    return { allowed: true, remaining: config.maxRequests - 1, retryAfterMs: 0 };
  }
}

export function rateLimitSync(
  key: string,
  preset: RateLimitPreset
): { allowed: boolean; remaining: number; retryAfterMs: number } {
  return memoryLimit(key, preset);
}
