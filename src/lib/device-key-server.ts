// ====================================================================
// Nexus Gate — Device Key Management (SERVER-SIDE)
// --------------------------------------------------------------------
// Verifies Ed25519 scan certificate signatures against registered
// device public keys, and handles device key registration/lookup.
// ====================================================================

import { db } from "@/lib/db";
import { createPublicKey, createHash } from "crypto";
import type { ScanCertificate, SignedCertificate } from "@/lib/scan-certificate";
import { canonicalizeCertificate } from "@/lib/scan-certificate";

// ====================================================================
// Fingerprint computation (server-side, authoritative)
// ====================================================================

/**
 * Compute the SHA-256 fingerprint of an Ed25519 public key JWK.
 * The fingerprint is derived from the JWK's `x` property (the raw
 * 32-byte public key in base64url). This is the SAME algorithm used
 * by the client (device-key-client.ts) so both sides agree.
 */
export async function computeFingerprint(publicKeyJwk: JsonWebKey): Promise<string> {
  // Decode the base64url `x` field to raw bytes
  const xBase64Url = publicKeyJwk.x!;
  const xBase64 = xBase64Url.replace(/-/g, "+").replace(/_/g, "/");
  const xBytes = Buffer.from(xBase64, "base64");

  // SHA-256 hash of the raw public key bytes
  const hashBuffer = createHash("sha256").update(xBytes).digest();
  return hashBuffer.toString("hex");
}

// ====================================================================
// Device Key Registration & Lookup
// ====================================================================

/**
 * Register a device public key for an account.
 * If the fingerprint already exists (for this account), return the
 * existing key instead of creating a duplicate.
 *
 * SECURITY: the fingerprint is RECOMPUTED from the supplied publicKeyJwk
 * and must match the client-provided value. This prevents an attacker from
 * registering a key under a victim's fingerprint (which would let them
 * forge certificates that look up the victim's device row).
 */
export async function registerDeviceKey(params: {
  accountId: string;
  publicKeyJwk: JsonWebKey;
  fingerprint: string;
  label?: string;
}) {
  // Recompute the fingerprint from the public key to verify the binding.
  const recomputed = await computeFingerprint(params.publicKeyJwk);
  if (recomputed !== params.fingerprint) {
    throw new Error("Fingerprint does not match the supplied public key.");
  }

  // Check if this fingerprint is already registered (globally unique)
  const existing = await db.deviceKey.findUnique({
    where: { fingerprint: params.fingerprint },
  });

  if (existing) {
    // If it belongs to this account, just update the label/lastUsedAt
    if (existing.accountId === params.accountId) {
      return db.deviceKey.update({
        where: { id: existing.id },
        data: { label: params.label ?? existing.label, lastUsedAt: new Date() },
      });
    }
    // If it belongs to a DIFFERENT account, reject (device reuse detection)
    throw new Error("This device is already registered to another account.");
  }

  // Create a new device key. Wrap in try/catch for P2002 race condition:
  // two concurrent registrations for the same fingerprint can both pass
  // the findUnique check above, then the second create throws P2002.
  try {
    return await db.deviceKey.create({
      data: {
        accountId: params.accountId,
        publicKeyJwk: JSON.stringify(params.publicKeyJwk),
        fingerprint: params.fingerprint,
        label: params.label ?? null,
      },
    });
  } catch (e) {
    // P2002 = unique constraint violation. Re-fetch the existing key.
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      const rechecked = await db.deviceKey.findUnique({
        where: { fingerprint: params.fingerprint },
      });
      if (rechecked) {
        if (rechecked.accountId === params.accountId) {
          return rechecked;
        }
        throw new Error("This device is already registered to another account.");
      }
    }
    throw e;
  }
}

/**
 * Look up an active (non-revoked) device key by fingerprint.
 */
export async function findDeviceKeyByFingerprint(fingerprint: string) {
  return db.deviceKey.findFirst({
    where: { fingerprint, revokedAt: null },
  });
}

/**
 * Touch the lastUsedAt timestamp for a device key.
 */
export async function touchDeviceKey(fingerprint: string): Promise<void> {
  await db.deviceKey.updateMany({
    where: { fingerprint },
    data: { lastUsedAt: new Date() },
  });
}

/**
 * Revoke a device key by its ID. Only the owning account can revoke.
 * Revoked keys can't sign new scan certificates (findDeviceKeyByFingerprint
 * filters by revokedAt: null).
 */
export async function revokeDeviceKey(accountId: string, keyId: string): Promise<boolean> {
  const key = await db.deviceKey.findFirst({
    where: { id: keyId, accountId },
  });
  if (!key) return false;
  await db.deviceKey.update({
    where: { id: keyId },
    data: { revokedAt: new Date() },
  });
  return true;
}

// ====================================================================
// Certificate Signature Verification
// ====================================================================

/**
 * Convert a JWK Ed25519 public key to a Node.js crypto KeyObject.
 * The JWK `x` field is the raw 32-byte Ed25519 public key in base64url.
 */
function jwkToPublicKey(publicKeyJwk: JsonWebKey): ReturnType<typeof createPublicKey> {
  // The JWK `x` field is base64url-encoded raw public key bytes.
  // We convert it to a DER-encoded SPKI format that Node's crypto can import.
  // Ed25519 public key in DER SPKI format:
  //   30 2a     (SEQUENCE, 42 bytes)
  //   30 05     (SEQUENCE, 5 bytes — algorithm identifier)
  //   06 03 2b 65 70  (OID 1.3.101.112 = Ed25519)
  //   03 21 00 <32-byte key>  (BIT STRING, 33 bytes with leading 0x00)

  // SECURITY: Validate the JWK shape before using it
  if (!publicKeyJwk.x || typeof publicKeyJwk.x !== "string") {
    throw new Error("Invalid Ed25519 JWK: missing 'x' field");
  }
  if (publicKeyJwk.kty !== "OKP" || publicKeyJwk.crv !== "Ed25519") {
    throw new Error("Invalid Ed25519 JWK: must be kty=OKP, crv=Ed25519");
  }

  const xBase64Url = publicKeyJwk.x;
  const xBase64 = xBase64Url.replace(/-/g, "+").replace(/_/g, "/");
  const xBytes = Buffer.from(xBase64, "base64");

  // SECURITY: Ed25519 public keys are exactly 32 bytes
  if (xBytes.length !== 32) {
    throw new Error(`Invalid Ed25519 public key: x must be 32 bytes, got ${xBytes.length}`);
  }

  // SPKI header for Ed25519 (24 bytes prefix + 32 bytes key = 42 bytes total)
  const spkiPrefix = Buffer.from([
    0x30, 0x2a, // SEQUENCE, 42 bytes
    0x30, 0x05, // SEQUENCE, 5 bytes (algorithm)
    0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112 (Ed25519)
    0x03, 0x21, 0x00, // BIT STRING, 33 bytes, 0 unused bits
  ]);
  const derKey = Buffer.concat([spkiPrefix, xBytes]);

  return createPublicKey({
    key: derKey,
    format: "der",
    type: "spki",
  });
}

/**
 * Verify a signed scan certificate's Ed25519 signature.
 *
 * @param signed - the signed certificate (certificate + canonical + signature)
 * @param publicKeyJwk - the device's public key as a JWK (from the DB)
 * @returns true if the signature is valid, false otherwise
 */
export async function verifyCertificateSignature(
  signed: SignedCertificate,
  publicKeyJwk: JsonWebKey
): Promise<boolean> {
  try {
    // Re-canonicalize the certificate to ensure it matches what was signed
    const expectedCanonical = canonicalizeCertificate(signed.certificate);
    if (expectedCanonical !== signed.canonical) {
      // The canonical form doesn't match — tampering detected
      return false;
    }

    // Convert the JWK to a Node.js crypto public key
    const publicKey = jwkToPublicKey(publicKeyJwk);

    // Decode the signature from base64
    const signatureBytes = Buffer.from(signed.signature, "base64");
    const data = Buffer.from(signed.canonical, "utf8");

    // Verify the Ed25519 signature (null = no algorithm-specific parameters)
    const { verify } = await import("crypto");
    const isValid = verify(null, data, publicKey, signatureBytes);
    return isValid;
  } catch (e) {
    console.error("Certificate signature verification failed:", e);
    return false;
  }
}

// ====================================================================
// Full Certificate Verification (signature + DB lookup)
// ====================================================================

export interface CertificateVerificationResult {
  ok: boolean;
  reason?: "device_not_registered" | "device_revoked" | "invalid_signature";
  deviceKey?: Awaited<ReturnType<typeof findDeviceKeyByFingerprint>>;
}

/**
 * Full verification: look up the device key by fingerprint, check it's
 * not revoked, then verify the signature.
 *
 * This is the main entry point for the attendance route.
 */
export async function verifySignedCertificate(
  signed: SignedCertificate
): Promise<CertificateVerificationResult> {
  // 1. Look up the device key by fingerprint
  const deviceKey = await findDeviceKeyByFingerprint(signed.certificate.deviceFingerprint);
  if (!deviceKey) {
    return { ok: false, reason: "device_not_registered" };
  }

  // 2. Check not revoked (already filtered by findDeviceKeyByFingerprint,
  //    but double-check for safety)
  if (deviceKey.revokedAt) {
    return { ok: false, reason: "device_revoked" };
  }

  // 3. Verify the Ed25519 signature
  let publicKeyJwk: JsonWebKey;
  try {
    publicKeyJwk = JSON.parse(deviceKey.publicKeyJwk);
  } catch {
    return { ok: false, reason: "device_not_registered" };
  }

  // 3b. Recompute the fingerprint from the stored public key and verify it
  // matches the fingerprint used to look up this row. This catches any
  // drift between the stored fingerprint and the stored public key
  // (defense-in-depth: the register path also enforces this).
  const recomputedFingerprint = await computeFingerprint(publicKeyJwk);
  if (recomputedFingerprint !== signed.certificate.deviceFingerprint) {
    return { ok: false, reason: "invalid_signature" };
  }

  const signatureValid = await verifyCertificateSignature(signed, publicKeyJwk);
  if (!signatureValid) {
    return { ok: false, reason: "invalid_signature" };
  }

  // 4. Touch the lastUsedAt timestamp
  await touchDeviceKey(signed.certificate.deviceFingerprint);

  return { ok: true, deviceKey };
}
