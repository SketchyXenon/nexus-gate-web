// ====================================================================
// Nexus Gate - Override Certificate (v16 - offline-first overrides)
// --------------------------------------------------------------------
// An Override Certificate is a cryptographic proof that an ORGANIZER
// (or ADMIN) manually marked a student present at a specific moment.
// It is:
//
//   1. SIGNED by the organizer's device Ed25519 private key (unforgeable,
//      tamper-evident - editing any queued field breaks the signature).
//   2. BOUND to the event + student + reason + creation timestamp +
//      one-time-use nonce.
//   3. TIME-ANCHORED: the signed createdAt must fall within the event's
//      live check-in OR time-out window - evaluated at CREATION time,
//      not sync time (offline-first, mirrors scan certificates).
//   4. SYNC-BOUNDED: must reach the server within 24h of creation.
//      This is the availability/consistency trade-off: an organizer at a
//      venue with zero connectivity can queue entries all day, but
//      cannot fabricate entries days later claiming "was offline".
//
// Threat model this certificate defends against:
//   T2 tampering with queued offline items  -> signature covers all fields
//   T3 replay/duplicate submission          -> deterministic idempotency key
//   T4 retroactive fabrication              -> 24h sync deadline
//   T5 clock manipulation                   -> signed timestamp + skew limits
//
// The module mirrors src/lib/scan-certificate.ts (proven client+server
// safe - the browser only uses canonicalize/create/generateNonce; the
// HMAC-based key derivation is server-only, exactly like scans).
// ====================================================================

import { hmacSha256 } from "@/lib/auth";

// ---- Types ----

export interface OverrideCertificate {
  /** The event the override applies to */
  eventId: number;
  /** The 7-digit student ID being marked present */
  studentId: number;
  /** Human-readable reason (1-500 chars, signed byte-exact - never
   *  trimmed server-side or the canonical round-trip check breaks) */
  reason: string;
  /** Client-reported creation timestamp (ms since epoch) - the signed
   *  time anchor all window validation is evaluated against */
  createdAt: number;
  /** One-time-use random nonce (hex) - makes the idempotency key
   *  deterministic yet unique per creation */
  nonce: string;
  /** SHA-256 fingerprint of the device's Ed25519 public key (hex) */
  deviceFingerprint: string;
}

export interface SignedOverrideCertificate {
  /** The certificate (unsigned) */
  certificate: OverrideCertificate;
  /** Canonical JSON of the certificate (what was signed) */
  canonical: string;
  /** Ed25519 signature (base64) */
  signature: string;
}

// ====================================================================
// Canonical JSON - deterministic serialization for signing
// ====================================================================

/**
 * Produce a deterministic JSON string from an OverrideCertificate.
 * Keys are sorted alphabetically, no extra whitespace - the same
 * certificate always produces the same bytes, so the signature is
 * reproducible and verifiable.
 *
 * CRITICAL: `reason` must round-trip byte-identical. Do NOT trim,
 * normalize, or transform it anywhere between signing and verifying.
 */
export function canonicalizeOverrideCertificate(
  cert: OverrideCertificate,
): string {
  return JSON.stringify({
    createdAt: cert.createdAt,
    deviceFingerprint: cert.deviceFingerprint,
    eventId: cert.eventId,
    nonce: cert.nonce,
    reason: cert.reason,
    studentId: cert.studentId,
  });
}

// ====================================================================
// Idempotency Key Derivation (deterministic, tamper-proof)
// ====================================================================

/**
 * Derive a deterministic idempotency key from the certificate + device
 * fingerprint: HMAC-SHA256(deviceFingerprint, eventId:nonce).
 *
 *  - The same override (same nonce) always produces the same key.
 *  - A client CANNOT regenerate the key to bypass dedup (the nonce is
 *    part of the signed certificate; changing it breaks the signature).
 *  - The key is stored on the EventAttendance row, forensically linking
 *    it to the exact certificate that created it.
 */
export function deriveOverrideIdempotencyKey(
  cert: OverrideCertificate,
): string {
  return hmacSha256(cert.deviceFingerprint, `${cert.eventId}:${cert.nonce}`);
}

// ====================================================================
// Timestamp Validation (server-side, pure)
// ====================================================================

export type OverrideTimestampReason =
  | "clock_skew_too_large"
  | "scanned_in_future";

export interface OverrideTimestampResult {
  ok: boolean;
  reason?: OverrideTimestampReason;
  driftMs?: number;
}

/**
 * Maximum allowed forward clock skew (client clock ahead of server).
 * 0-60s: normal NTP drift, accepted silently.
 * 60-120s: accepted with a warning.
 * >120s: hard reject (likely deliberate clock manipulation).
 */
export const OVERRIDE_MAX_CLOCK_SKEW_MS = 60_000;
export const OVERRIDE_CLOCK_SKEW_GRACE_MS = 120_000;

/**
 * Maximum allowed sync delay for an override (ms).
 *
 * Overrides are OFFLINE-FIRST: an organizer at a venue with no
 * connectivity queues signed entries and syncs when connectivity
 * returns. 24 hours is generous enough for "queue all day at a remote
 * venue, sync from the hotel" but NOT enough for retroactive
 * fabrication ("the student attended last week, trust me"). Beyond
 * this window the organizer must escalate to an administrator.
 *
 * (Scans use 15 minutes - scans happen on venue WiFi. Overrides are
 * deliberately more tolerant because the organizer's device is the
 * offline unit, and every delayed row is flagged `offline=true` for
 * admin forensic review.)
 */
export const OVERRIDE_MAX_SYNC_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Validate the certificate's creation timestamp against server time.
 *
 * Checks:
 *   1. createdAt is not too far in the future (>120s hard reject,
 *      60-120s accepted with a warning).
 *   2. createdAt is not too old (beyond the 24h sync deadline).
 *
 * Event-window validation (was the event live at createdAt?) is done
 * separately by the route via getEventTimeWindows - this function only
 * bounds the certificate's relationship to the sync clock.
 */
export function validateOverrideTimestamp(
  cert: OverrideCertificate,
  now: number = Date.now(),
): OverrideTimestampResult {
  const driftMs = now - cert.createdAt;

  // Forward skew: client clock is ahead of server.
  if (driftMs < -OVERRIDE_CLOCK_SKEW_GRACE_MS) {
    return { ok: false, reason: "scanned_in_future", driftMs };
  }
  if (driftMs < -OVERRIDE_MAX_CLOCK_SKEW_MS) {
    // 60-120s forward skew - log a warning but accept.
    console.warn(
      `[override-certificate] clock skew warning: client is ${Math.abs(driftMs)}ms ahead`,
    );
  }

  // Reject if the override was created too long ago (beyond sync window).
  if (driftMs > OVERRIDE_MAX_SYNC_DELAY_MS) {
    return { ok: false, reason: "clock_skew_too_large", driftMs };
  }

  return { ok: true, driftMs };
}

// ====================================================================
// Certificate Creation Helper (client-side)
// ====================================================================

/**
 * Create a new OverrideCertificate from the form data.
 * The client calls this, then signs the canonical JSON with the
 * device's Ed25519 private key.
 */
export function createOverrideCertificate(params: {
  eventId: number;
  studentId: number;
  reason: string;
  deviceFingerprint: string;
  createdAt?: number;
  nonce?: string;
}): OverrideCertificate {
  return {
    eventId: params.eventId,
    studentId: params.studentId,
    reason: params.reason,
    createdAt: params.createdAt ?? Date.now(),
    nonce: params.nonce ?? generateNonce(),
    deviceFingerprint: params.deviceFingerprint,
  };
}

/**
 * Generate a random nonce (16 bytes hex = 32 chars).
 * Uses crypto.getRandomValues if available (browser/Node 19+),
 * otherwise falls back to crypto.randomUUID().
 */
export function generateNonce(): string {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Fallback (shouldn't happen in modern browsers/Node)
  return crypto.randomUUID().replace(/-/g, "");
}
