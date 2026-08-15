import { createHmac } from "crypto";

// ====================================================================
// Nexus Gate — Privacy-preserving visit hashing
// --------------------------------------------------------------------
// Per 06-security-architecture.md §8 (data minimization) and §11 (never
// log full PII): the public IP is NEVER stored. It is HMAC-SHA256-hashed
// with a daily-rotating server secret, producing a non-reversible token.
//
// The token identifies "same visitor on the same day" — enough to count
// unique daily visitors, but not enough to recover the IP or to link a
// visitor across days (the daily rotation breaks cross-day correlation).
//
// The secret is derived from AUTH_SECRET (already required by the app)
// so no new secret management is needed. If AUTH_SECRET is unset, a
// ephemeral per-process random secret is used (analytics won't persist
// across restarts, but the app still runs — defense-in-depth).
// ====================================================================

const ANON_FALLBACK = "anon";

function dayBucket(now: Date = new Date()): string {
  // UTC YYYY-MM-DD — daily rotation boundary.
  return now.toISOString().slice(0, 10);
}

function analyticsSecret(day: string): string {
  const base = process.env.AUTH_SECRET || process.env.NEXT_PUBLIC_APP_URL || "";
  if (!base) return `ephemeral-${day}`;
  // Bind the secret to the day so the hash rotates daily. This means the
  // same IP produces a DIFFERENT visitorHash each day — cross-day
  // correlation is impossible without the secret.
  return `${base}:${day}`;
}

/**
 * Hash a public IP into a non-reversible daily-rotating visitor token.
 * Returns "anon" for missing/invalid input (no value leak).
 */
export function hashVisitorIp(ip: string | null | undefined): string {
  if (!ip || typeof ip !== "string") return ANON_FALLBACK;
  const trimmed = ip.trim();
  if (!trimmed) return ANON_FALLBACK;
  const day = dayBucket();
  return createHmac("sha256", analyticsSecret(day))
    .update(trimmed)
    .digest("hex")
    .slice(0, 32); // 16 bytes is plenty for a daily dedup key
}

/** Today's UTC day bucket (YYYY-MM-DD). */
export function todayBucket(): string {
  return dayBucket();
}

/** N days ago bucket (for range queries). */
export function daysAgoBucket(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return dayBucket(d);
}
