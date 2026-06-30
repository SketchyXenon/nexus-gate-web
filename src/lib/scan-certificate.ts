// ====================================================================
// Nexus Gate — Scan Certificate (v8 — Tier 1 + Tier 2)
// --------------------------------------------------------------------
// A Scan Certificate is a cryptographic proof that a student's device
// captured a valid QR token at a specific moment in time. It is:
//
//   1. SIGNED by the device's Ed25519 private key (unforgeable).
//   2. BOUND to the QR token + the client's scan timestamp.
//   3. ENRICHED with multi-frame sub-frame indices (Tier 2 liveness).
//   4. GIVEN a one-time-use nonce (deterministic idempotency key).
//
// The certificate decouples "the student saw a valid QR" from "the
// scan arrived at the server." This means:
//   - A scan made at 9:00 AM that syncs at 2:00 PM is still valid.
//   - The server validates the token's HMAC against the certificate's
//     scannedAt timestamp (NOT the sync time).
//   - Tampering with any field breaks the Ed25519 signature.
// ====================================================================

import { hmacSha256 } from "@/lib/auth";

// ---- Types ----

export interface SubFrameCapture {
  /** The sub-frame index (0–29) */
  subFrame: number;
  /** The HMAC the scanner observed in that sub-frame (hex) */
  hmac: string;
}

export interface ScanCertificate {
  /** The event ID from the QR token */
  eventId: number;
  /** The raw QR payload string (e.g. "9001.12345.5.abc123...") */
  token: string;
  /** Client-reported scan timestamp (ms since epoch) */
  scannedAt: number;
  /** One-time-use random nonce (UUID or hex string) */
  nonce: string;
  /** SHA-256 fingerprint of the device's Ed25519 public key (hex) */
  deviceFingerprint: string;
  /** Captured sub-frames WITH their client-observed HMACs (Tier 2 liveness proof) */
  subFrames: SubFrameCapture[];
}

export interface SignedCertificate {
  /** The certificate (unsigned) */
  certificate: ScanCertificate;
  /** Canonical JSON of the certificate (what was signed) */
  canonical: string;
  /** Ed25519 signature (base64) */
  signature: string;
}

// ====================================================================
// Canonical JSON — deterministic serialization for signing
// ====================================================================

/**
 * Produce a deterministic JSON string from a ScanCertificate.
 * Keys are sorted alphabetically, no extra whitespace.
 * This ensures the same certificate always produces the same bytes,
 * so the signature is reproducible and verifiable.
 */
export function canonicalizeCertificate(cert: ScanCertificate): string {
  return JSON.stringify({
    deviceFingerprint: cert.deviceFingerprint,
    eventId: cert.eventId,
    nonce: cert.nonce,
    scannedAt: cert.scannedAt,
    // Sort sub-frames by index for deterministic canonicalization
    subFrames: [...cert.subFrames].sort((a, b) => a.subFrame - b.subFrame),
    token: cert.token,
  });
}

// ====================================================================
// Idempotency Key Derivation (deterministic, tamper-proof)
// ====================================================================

/**
 * Derive a deterministic idempotency key from the certificate + device
 * fingerprint.
 *
 * The key is HMAC-SHA256(deviceFingerprint, eventId:nonce). This means:
 *   - The same scan (same nonce) always produces the same key.
 *   - A client CANNOT regenerate the key to bypass dedup (the nonce is
 *     part of the signed certificate; changing it produces a different
 *     signature → rejected).
 *   - The key is tied to the device, so two devices scanning the same
 *     nonce produce different keys (but the (eventId, accountId) unique
 *     constraint still prevents double-attendance).
 */
export function deriveIdempotencyKey(cert: ScanCertificate): string {
  return hmacSha256(cert.deviceFingerprint, `${cert.eventId}:${cert.nonce}`);
}

// ====================================================================
// Certificate Validation (server-side, pure)
// ====================================================================

export type CertificateValidationReason =
  | "clock_skew_too_large"
  | "scanned_in_future"
  | "insufficient_subframes"
  | "token_event_mismatch";

export interface CertificateValidationResult {
  ok: boolean;
  reason?: CertificateValidationReason;
  driftMs?: number;
}

/** Maximum allowed clock skew between client and server (ms). */
export const MAX_CLOCK_SKEW_MS = 60_000; // 60 seconds

/**
 * Validate the certificate's timestamp against the current server time.
 *
 * Checks:
 *   1. scannedAt is not in the future (beyond MAX_CLOCK_SKEW_MS).
 *   2. Clock skew (|now - scannedAt|) is within MAX_CLOCK_SKEW_MS.
 *
 * This does NOT validate the token HMAC — that's done separately by
 * validateQrPayload() using the certificate's scannedAt as the reference
 * time (so offline scans are accepted).
 */
export function validateCertificateTimestamp(
  cert: ScanCertificate,
  now: number = Date.now()
): CertificateValidationResult {
  const driftMs = now - cert.scannedAt;

  // Allow up to MAX_CLOCK_SKEW_MS in the future (client clock slightly ahead)
  if (driftMs < -MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: "scanned_in_future", driftMs };
  }

  // Reject if the scan is too old (beyond the idempotency window)
  // We use 24 hours as the max sync delay (matches IDEMPOTENCY_TTL_HOURS)
  const MAX_SYNC_DELAY_MS = 24 * 60 * 60 * 1000;
  if (driftMs > MAX_SYNC_DELAY_MS) {
    return { ok: false, reason: "clock_skew_too_large", driftMs };
  }

  return { ok: true, driftMs };
}

/**
 * Validate that the certificate's eventId matches the token's eventId.
 * (Prevents a student from using a token from event A to check into event B.)
 */
export function validateCertificateEventMatch(
  cert: ScanCertificate,
  tokenEventId: number
): CertificateValidationResult {
  if (cert.eventId !== tokenEventId) {
    return { ok: false, reason: "token_event_mismatch" };
  }
  return { ok: true };
}

// ====================================================================
// Certificate Creation Helper (client-side)
// ====================================================================

/**
 * Create a new ScanCertificate from the captured scan data.
 * The client calls this, then signs the canonical JSON with the device's
 * Ed25519 private key.
 *
 * @param params.eventId - the event ID
 * @param params.token - the raw QR payload
 * @param params.deviceFingerprint - SHA-256 of the device's public key
 * @param params.subFrames - captured sub-frames WITH their client-observed HMACs
 * @param params.scannedAt - optional, defaults to Date.now()
 * @param params.nonce - optional, defaults to a random UUID
 */
export function createCertificate(params: {
  eventId: number;
  token: string;
  deviceFingerprint: string;
  subFrames: SubFrameCapture[];
  scannedAt?: number;
  nonce?: string;
}): ScanCertificate {
  return {
    eventId: params.eventId,
    token: params.token,
    scannedAt: params.scannedAt ?? Date.now(),
    nonce: params.nonce ?? generateNonce(),
    deviceFingerprint: params.deviceFingerprint,
    subFrames: [...params.subFrames].sort((a, b) => a.subFrame - b.subFrame),
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
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback (shouldn't happen in modern browsers/Node)
  return crypto.randomUUID().replace(/-/g, "");
}
