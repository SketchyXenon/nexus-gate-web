// ====================================================================
// Nexus Gate — Constant-time comparison helpers (timing attack defense)
// ====================================================================
// Used for HMAC signature comparisons where a timing-unsafe `===` could
// leak byte-by-byte equality to an attacker making many requests.
// ====================================================================

import { timingSafeEqual } from "crypto";

const HEX_RE = /^[0-9a-f]*$/;

/**
 * Constant-time comparison of two hex strings.
 *
 * Contract: both inputs MUST be lowercase hex of equal length. HMAC-SHA256
 * outputs are always 64 lowercase hex chars, so length is not a secret here —
 * the early return on length mismatch is safe and avoids passing mismatched
 * buffers to timingSafeEqual (which throws on length mismatch).
 *
 * Non-hex input or mixed case returns false rather than throwing — defense
 * against a malformed client-supplied HMAC reaching this path.
 */
export function timingSafeCompareHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  // Reject non-hex / mixed-case early so we never compare malformed input.
  if (a.length > 0 && (!HEX_RE.test(a) || !HEX_RE.test(b))) return false;
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  return timingSafeEqual(aBuf, bBuf);
}
