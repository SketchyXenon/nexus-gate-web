import { describe, it, expect } from "vitest";
import {
  createCertificate,
  canonicalizeCertificate,
  deriveIdempotencyKey,
  validateCertificateTimestamp,
  validateCertificateEventMatch,
  generateNonce,
  type ScanCertificate,
  type SubFrameCapture,
} from "./scan-certificate";

// ====================================================================
// Unit tests for the Scan Certificate system (v8 Tier 1 + Tier 2).
// ====================================================================

// Helper: create sub-frame captures (index + hmac)
function sf(subFrame: number, hmac?: string): SubFrameCapture {
  return { subFrame, hmac: hmac ?? "a".repeat(64) };
}

describe("canonicalizeCertificate", () => {
  it("produces deterministic JSON with sorted keys", () => {
    const cert: ScanCertificate = {
      eventId: 42,
      token: "42.100.5.abc",
      scannedAt: 1700000000000,
      nonce: "deadbeef",
      deviceFingerprint: "abc123",
      subFrames: [sf(3), sf(1), sf(2)],
    };
    const canonical = canonicalizeCertificate(cert);
    // Keys must be alphabetical; sub-frames sorted by index
    expect(canonical).toBe(
      JSON.stringify({
        deviceFingerprint: "abc123",
        eventId: 42,
        nonce: "deadbeef",
        scannedAt: 1700000000000,
        subFrames: [sf(1), sf(2), sf(3)],
        token: "42.100.5.abc",
      })
    );
  });

  it("produces the SAME output for the same input", () => {
    const cert: ScanCertificate = {
      eventId: 1,
      token: "token",
      scannedAt: 1000,
      nonce: "nonce",
      deviceFingerprint: "fp",
      subFrames: [sf(0), sf(1)],
    };
    expect(canonicalizeCertificate(cert)).toBe(canonicalizeCertificate(cert));
  });

  it("produces DIFFERENT output when any field changes", () => {
    const base: ScanCertificate = {
      eventId: 1,
      token: "token",
      scannedAt: 1000,
      nonce: "nonce",
      deviceFingerprint: "fp",
      subFrames: [sf(0)],
    };
    const variants: Partial<ScanCertificate>[] = [
      { eventId: 2 },
      { token: "different" },
      { scannedAt: 2000 },
      { nonce: "different" },
      { deviceFingerprint: "different" },
      { subFrames: [sf(1)] },
    ];
    const baseCanonical = canonicalizeCertificate(base);
    for (const variant of variants) {
      const modified = { ...base, ...variant };
      expect(canonicalizeCertificate(modified)).not.toBe(baseCanonical);
    }
  });
});

describe("deriveIdempotencyKey", () => {
  it("produces a deterministic key for the same certificate", () => {
    const cert: ScanCertificate = {
      eventId: 1,
      token: "token",
      scannedAt: 1000,
      nonce: "nonce",
      deviceFingerprint: "fp",
      subFrames: [sf(0)],
    };
    const key1 = deriveIdempotencyKey(cert);
    const key2 = deriveIdempotencyKey(cert);
    expect(key1).toBe(key2);
  });

  it("produces DIFFERENT keys for different nonces", () => {
    const base: ScanCertificate = {
      eventId: 1,
      token: "token",
      scannedAt: 1000,
      nonce: "nonce1",
      deviceFingerprint: "fp",
      subFrames: [sf(0)],
    };
    const key1 = deriveIdempotencyKey(base);
    const key2 = deriveIdempotencyKey({ ...base, nonce: "nonce2" });
    expect(key1).not.toBe(key2);
  });

  it("produces DIFFERENT keys for different device fingerprints", () => {
    const base: ScanCertificate = {
      eventId: 1,
      token: "token",
      scannedAt: 1000,
      nonce: "nonce",
      deviceFingerprint: "fp1",
      subFrames: [sf(0)],
    };
    const key1 = deriveIdempotencyKey(base);
    const key2 = deriveIdempotencyKey({ ...base, deviceFingerprint: "fp2" });
    expect(key1).not.toBe(key2);
  });

  it("produces a hex string", () => {
    const cert: ScanCertificate = {
      eventId: 1,
      token: "token",
      scannedAt: 1000,
      nonce: "nonce",
      deviceFingerprint: "fp",
      subFrames: [sf(0)],
    };
    const key = deriveIdempotencyKey(cert);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });
});

describe("validateCertificateTimestamp", () => {
  const now = 1700000000000;

  it("accepts a certificate scanned at the current time", () => {
    const cert: ScanCertificate = {
      eventId: 1,
      token: "token",
      scannedAt: now,
      nonce: "nonce",
      deviceFingerprint: "fp",
      subFrames: [sf(0)],
    };
    const result = validateCertificateTimestamp(cert, now);
    expect(result.ok).toBe(true);
  });

  it("accepts a certificate scanned 10 seconds ago (within skew)", () => {
    const cert: ScanCertificate = {
      eventId: 1,
      token: "token",
      scannedAt: now - 10_000,
      nonce: "nonce",
      deviceFingerprint: "fp",
      subFrames: [sf(0)],
    };
    const result = validateCertificateTimestamp(cert, now);
    expect(result.ok).toBe(true);
  });

  it("accepts a certificate scanned 10 seconds in the future (within skew)", () => {
    const cert: ScanCertificate = {
      eventId: 1,
      token: "token",
      scannedAt: now + 10_000,
      nonce: "nonce",
      deviceFingerprint: "fp",
      subFrames: [sf(0)],
    };
    const result = validateCertificateTimestamp(cert, now);
    expect(result.ok).toBe(true);
  });

  it("rejects a certificate scanned 2 minutes in the future (beyond skew)", () => {
    const cert: ScanCertificate = {
      eventId: 1,
      token: "token",
      scannedAt: now + 120_000,
      nonce: "nonce",
      deviceFingerprint: "fp",
      subFrames: [sf(0)],
    };
    const result = validateCertificateTimestamp(cert, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("scanned_in_future");
  });

  it("rejects a certificate scanned 25 hours ago (beyond sync delay)", () => {
    const cert: ScanCertificate = {
      eventId: 1,
      token: "token",
      scannedAt: now - 25 * 60 * 60 * 1000,
      nonce: "nonce",
      deviceFingerprint: "fp",
      subFrames: [sf(0)],
    };
    const result = validateCertificateTimestamp(cert, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("clock_skew_too_large");
  });

  it("accepts a certificate scanned 23 hours ago (within sync delay)", () => {
    const cert: ScanCertificate = {
      eventId: 1,
      token: "token",
      scannedAt: now - 23 * 60 * 60 * 1000,
      nonce: "nonce",
      deviceFingerprint: "fp",
      subFrames: [sf(0)],
    };
    const result = validateCertificateTimestamp(cert, now);
    expect(result.ok).toBe(true);
  });
});

describe("validateCertificateEventMatch", () => {
  it("accepts when certificate eventId matches token eventId", () => {
    const cert: ScanCertificate = {
      eventId: 42,
      token: "42.100.5.abc",
      scannedAt: 1000,
      nonce: "nonce",
      deviceFingerprint: "fp",
      subFrames: [sf(0)],
    };
    const result = validateCertificateEventMatch(cert, 42);
    expect(result.ok).toBe(true);
  });

  it("rejects when certificate eventId does NOT match token eventId", () => {
    const cert: ScanCertificate = {
      eventId: 42,
      token: "42.100.5.abc",
      scannedAt: 1000,
      nonce: "nonce",
      deviceFingerprint: "fp",
      subFrames: [sf(0)],
    };
    const result = validateCertificateEventMatch(cert, 99);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("token_event_mismatch");
  });
});

describe("generateNonce", () => {
  it("generates a 32-character hex string", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates unique nonces on each call", () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 100; i++) {
      nonces.add(generateNonce());
    }
    expect(nonces.size).toBe(100);
  });
});

describe("createCertificate", () => {
  it("creates a certificate with the provided values", () => {
    const cert = createCertificate({
      eventId: 42,
      token: "token",
      deviceFingerprint: "fp",
      subFrames: [sf(0), sf(1), sf(2)],
    });
    expect(cert.eventId).toBe(42);
    expect(cert.token).toBe("token");
    expect(cert.deviceFingerprint).toBe("fp");
    expect(cert.subFrames).toHaveLength(3);
    expect(cert.scannedAt).toBeGreaterThan(0);
    expect(cert.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("sorts sub-frames by index on creation", () => {
    const cert = createCertificate({
      eventId: 42,
      token: "token",
      deviceFingerprint: "fp",
      subFrames: [sf(2), sf(0), sf(1)],
    });
    expect(cert.subFrames.map((s) => s.subFrame)).toEqual([0, 1, 2]);
  });

  it("accepts a custom scannedAt", () => {
    const cert = createCertificate({
      eventId: 42,
      token: "token",
      deviceFingerprint: "fp",
      subFrames: [sf(0)],
      scannedAt: 12345,
    });
    expect(cert.scannedAt).toBe(12345);
  });

  it("accepts a custom nonce", () => {
    const cert = createCertificate({
      eventId: 42,
      token: "token",
      deviceFingerprint: "fp",
      subFrames: [sf(0)],
      nonce: "customnonce",
    });
    expect(cert.nonce).toBe("customnonce");
  });
});
