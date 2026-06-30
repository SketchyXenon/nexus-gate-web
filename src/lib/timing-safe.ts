// ====================================================================
// Nexus Gate — Constant-time comparison helpers (timing attack defense)
// ====================================================================
// Used for HMAC signature comparisons where a timing-unsafe `===` could
// leak byte-by-byte equality to an attacker making many requests.
// ====================================================================

import { timingSafeEqual } from "crypto";

/**
 * Constant-time comparison of two hex strings.
 * Returns false immediately if lengths differ (safe — length is not secret
 * for HMAC outputs which are always a fixed length).
 */
export function timingSafeCompareHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  return timingSafeEqual(aBuf, bBuf);
}
