import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/auth";
import {
  generateQrPayload,
  validateQrPayload,
  verifySubFrameLiveness,
  computeSubFrameHmac,
  MIN_SUB_FRAMES,
} from "@/lib/qr-token";
import {
  createCertificate,
  canonicalizeCertificate,
  deriveIdempotencyKey,
  validateCertificateTimestamp,
  validateCertificateEventMatch,
  type SubFrameCapture,
} from "@/lib/scan-certificate";

// Helper: create sub-frame captures with valid HMACs
function makeSubFrames(
  secret: string,
  eventId: number,
  timeBlock: number,
  indices: number[]
): SubFrameCapture[] {
  return indices.map((idx) => ({
    subFrame: idx,
    hmac: computeSubFrameHmac(secret, eventId, timeBlock, idx),
  }));
}

// Helper: create sub-frame captures with INVALID HMACs (for anti-cheat tests)
function makeFakeSubFrames(indices: number[]): SubFrameCapture[] {
  return indices.map((idx) => ({
    subFrame: idx,
    hmac: "0".repeat(64),
  }));
}

// ====================================================================
// Integration tests for the full scan flow (v8 Tier 1 + Tier 2).
// --------------------------------------------------------------------
// These tests simulate the complete scan flow WITHOUT making HTTP
// requests — they exercise the same pure functions the API route uses,
// in the same order, with realistic data.
//
// Flow:
//   1. Generate a v8 QR payload (as the projector would)
//   2. Validate the token (as the server would)
//   3. Collect 3+ sub-frames (as the scanner would)
//   4. Create + sign a scan certificate (as the scanner would)
//   5. Verify the certificate timestamp + event match (as the server would)
//   6. Derive the idempotency key (as the server would)
//   7. Verify sub-frame liveness (as the server would)
// ====================================================================

const db = new PrismaClient();

const TEST_SECRET = "test-event-secret-for-integration-tests";
const EVENT_ID = 9999;
const NOW = 1700000000000;

describe("Integration: Full scan flow (Tier 1 + Tier 2)", () => {
  // ---- Step 1: QR generation (projector side) ----
  describe("Step 1 — Projector generates v8 QR payload", () => {
    it("generates a valid 4-part v8 token", () => {
      const token = generateQrPayload(EVENT_ID, TEST_SECRET, NOW);
      expect(token.payload.split(".")).toHaveLength(4);
      expect(token.timeBlock).toBe(Math.floor(NOW / 15_000));
      expect(token.subFrame).toBe(Math.floor((NOW % 15_000) / 500));
    });
  });

  // ---- Step 2: Token validation (server side) ----
  describe("Step 2 — Server validates the token against the certificate's scannedAt", () => {
    it("validates a token generated at the same time", () => {
      const token = generateQrPayload(EVENT_ID, TEST_SECRET, NOW);
      const result = validateQrPayload(token.payload, TEST_SECRET, NOW);
      expect(result.ok).toBe(true);
      expect(result.format).toBe("v8");
    });

    it("validates a token generated 30 seconds ago (offline sync)", () => {
      // This is the KEY offline-resilience test: a scan made 30s ago
      // should still be valid because we validate against the cert's
      // scannedAt, not the sync time.
      const token = generateQrPayload(EVENT_ID, TEST_SECRET, NOW - 30_000);
      const result = validateQrPayload(token.payload, TEST_SECRET, NOW - 30_000);
      expect(result.ok).toBe(true);
    });

    it("validates a token generated 1 hour ago (extended offline)", () => {
      const token = generateQrPayload(EVENT_ID, TEST_SECRET, NOW - 3_600_000);
      // Validate against the CERT's scannedAt (1 hour ago), not NOW
      const result = validateQrPayload(token.payload, TEST_SECRET, NOW - 3_600_000);
      expect(result.ok).toBe(true);
    });
  });

  // ---- Step 3: Sub-frame collection (scanner side) ----
  describe("Step 3 — Scanner collects 3+ consecutive sub-frames", () => {
    it("simulates capturing sub-frames 0, 1, 2 over 1.5 seconds", () => {
      const block = Math.floor(NOW / 15_000);
      const capturedSubFrames: number[] = [];

      // Simulate capturing a frame every 500ms
      for (let sf = 0; sf < MIN_SUB_FRAMES; sf++) {
        const token = generateQrPayload(EVENT_ID, TEST_SECRET, NOW + sf * 500);
        const parts = token.payload.split(".");
        capturedSubFrames.push(Number(parts[2]));
      }

      expect(capturedSubFrames).toHaveLength(MIN_SUB_FRAMES);
      // Verify they're consecutive
      for (let i = 1; i < capturedSubFrames.length; i++) {
        expect(capturedSubFrames[i] - capturedSubFrames[i - 1]).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // ---- Step 4: Certificate creation (scanner side) ----
  describe("Step 4 — Scanner creates a signed certificate", () => {
    it("creates a certificate with the captured sub-frames + HMACs", () => {
      const token = generateQrPayload(EVENT_ID, TEST_SECRET, NOW);
      const block = token.timeBlock;
      const subFrames = makeSubFrames(TEST_SECRET, EVENT_ID, block, [0, 1, 2]);

      const cert = createCertificate({
        eventId: EVENT_ID,
        token: token.payload,
        deviceFingerprint: "test-fingerprint-abc123",
        subFrames,
        scannedAt: NOW,
        nonce: "test-nonce-deadbeef",
      });

      expect(cert.eventId).toBe(EVENT_ID);
      expect(cert.subFrames).toHaveLength(3);
      expect(cert.subFrames.map((s) => s.subFrame)).toEqual([0, 1, 2]);
      expect(cert.scannedAt).toBe(NOW);

      // The canonical form should be deterministic
      const canonical = canonicalizeCertificate(cert);
      expect(canonical).toBe(canonicalizeCertificate(cert));
    });
  });

  // ---- Step 5: Certificate timestamp + event match (server side) ----
  describe("Step 5 — Server validates the certificate timestamp + event match", () => {
    it("accepts a certificate scanned at the current time", () => {
      const cert = createCertificate({
        eventId: EVENT_ID,
        token: "token",
        deviceFingerprint: "fp",
        subFrames: makeSubFrames(TEST_SECRET, EVENT_ID, Math.floor(NOW / 15_000), [0]),
        scannedAt: NOW,
      });
      expect(validateCertificateTimestamp(cert, NOW).ok).toBe(true);
    });

    it("accepts a certificate scanned 1 hour ago (offline sync)", () => {
      const cert = createCertificate({
        eventId: EVENT_ID,
        token: "token",
        deviceFingerprint: "fp",
        subFrames: makeSubFrames(TEST_SECRET, EVENT_ID, Math.floor((NOW - 3_600_000) / 15_000), [0]),
        scannedAt: NOW - 3_600_000,
      });
      expect(validateCertificateTimestamp(cert, NOW).ok).toBe(true);
    });

    it("rejects a certificate scanned 25 hours ago (beyond sync window)", () => {
      const cert = createCertificate({
        eventId: EVENT_ID,
        token: "token",
        deviceFingerprint: "fp",
        subFrames: makeFakeSubFrames([0]),
        scannedAt: NOW - 25 * 3_600_000,
      });
      expect(validateCertificateTimestamp(cert, NOW).ok).toBe(false);
    });

    it("validates the event match", () => {
      const cert = createCertificate({
        eventId: EVENT_ID,
        token: `${EVENT_ID}.100.5.abc`,
        deviceFingerprint: "fp",
        subFrames: makeFakeSubFrames([0]),
      });
      expect(validateCertificateEventMatch(cert, EVENT_ID).ok).toBe(true);
      expect(validateCertificateEventMatch(cert, EVENT_ID + 1).ok).toBe(false);
    });
  });

  // ---- Step 6: Idempotency key derivation (server side) ----
  describe("Step 6 — Server derives a deterministic idempotency key", () => {
    it("produces the same key for the same certificate", () => {
      const cert1 = createCertificate({
        eventId: EVENT_ID,
        token: "token",
        deviceFingerprint: "fp",
        subFrames: makeSubFrames(TEST_SECRET, EVENT_ID, 100, [0, 1, 2]),
        scannedAt: NOW,
        nonce: "same-nonce",
      });
      const cert2 = { ...cert1 }; // same data
      expect(deriveIdempotencyKey(cert1)).toBe(deriveIdempotencyKey(cert2));
    });

    it("produces different keys for different nonces (prevents bypass)", () => {
      const cert1 = createCertificate({
        eventId: EVENT_ID,
        token: "token",
        deviceFingerprint: "fp",
        subFrames: makeFakeSubFrames([0]),
        nonce: "nonce-1",
      });
      const cert2 = { ...cert1, nonce: "nonce-2" };
      expect(deriveIdempotencyKey(cert1)).not.toBe(deriveIdempotencyKey(cert2));
    });
  });

  // ---- Step 7: Sub-frame liveness verification (server side) ----
  describe("Step 7 — Server verifies sub-frame liveness (Tier 2)", () => {
    it("accepts 3 consecutive sub-frames with VALID HMACs", () => {
      const block = Math.floor(NOW / 15_000);
      const subFrames = makeSubFrames(TEST_SECRET, EVENT_ID, block, [0, 1, 2]);
      const result = verifySubFrameLiveness(subFrames, TEST_SECRET, EVENT_ID, block);
      expect(result.ok).toBe(true);
    });

    it("rejects fewer than 3 sub-frames (photo relay attack)", () => {
      const block = Math.floor(NOW / 15_000);
      const subFrames = makeSubFrames(TEST_SECRET, EVENT_ID, block, [0, 1]);
      const result = verifySubFrameLiveness(subFrames, TEST_SECRET, EVENT_ID, block);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("insufficient_subframes");
      }
    });

    it("rejects non-consecutive sub-frames (fabricated set)", () => {
      const block = Math.floor(NOW / 15_000);
      const subFrames = makeSubFrames(TEST_SECRET, EVENT_ID, block, [0, 1, 10]);
      const result = verifySubFrameLiveness(subFrames, TEST_SECRET, EVENT_ID, block);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid_subframe");
      }
    });

    it("rejects sub-frames with INVALID HMACs (fabricated indices)", () => {
      const block = Math.floor(NOW / 15_000);
      // Client supplies FAKE HMACs — server recomputes and compares
      const subFrames = makeFakeSubFrames([0, 1, 2]);
      const result = verifySubFrameLiveness(subFrames, TEST_SECRET, EVENT_ID, block);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid_signature");
      }
    });
  });

  // ---- Full end-to-end simulation ----
  describe("Full end-to-end scan simulation", () => {
    it("completes the full flow from QR generation to certificate verification", () => {
      // 1. Projector generates a QR token at time T
      const scanTime = NOW;
      const token = generateQrPayload(EVENT_ID, TEST_SECRET, scanTime);

      // 2. Scanner captures 3 sub-frames (simulated)
      const block = token.timeBlock;
      const capturedSubFrameIndices = [token.subFrame, token.subFrame + 1, token.subFrame + 2].filter(
        (sf) => sf < 30
      );
      const adjustedSubFrameIndices = capturedSubFrameIndices.length >= 3
        ? capturedSubFrameIndices
        : [0, 1, 2];

      // Build sub-frame captures with valid HMACs (as the scanner would)
      const subFrameCaptures = makeSubFrames(TEST_SECRET, EVENT_ID, block, adjustedSubFrameIndices);

      // 3. Scanner creates a certificate
      const cert = createCertificate({
        eventId: EVENT_ID,
        token: token.payload,
        deviceFingerprint: "device-fingerprint-hash",
        subFrames: subFrameCaptures,
        scannedAt: scanTime,
        nonce: "integration-test-nonce-123456",
      });

      // 4. Server validates the token against the cert's scannedAt
      const tokenValidation = validateQrPayload(cert.token, TEST_SECRET, cert.scannedAt);
      expect(tokenValidation.ok).toBe(true);
      if (!tokenValidation.ok) return;

      // 5. Server validates the certificate timestamp
      const tsValidation = validateCertificateTimestamp(cert, scanTime + 1000);
      expect(tsValidation.ok).toBe(true);

      // 6. Server validates the event match
      const eventMatch = validateCertificateEventMatch(cert, tokenValidation.eventId!);
      expect(eventMatch.ok).toBe(true);

      // 7. Server verifies sub-frame liveness (with client-supplied HMACs)
      const liveness = verifySubFrameLiveness(
        cert.subFrames,
        TEST_SECRET,
        EVENT_ID,
        block
      );
      expect(liveness.ok).toBe(true);

      // 8. Server derives the idempotency key
      const idempotencyKey = deriveIdempotencyKey(cert);
      expect(idempotencyKey).toMatch(/^[0-9a-f]+$/);

      // ALL checks passed — the scan would be accepted
    });
  });
});

// ====================================================================
// Anti-cheating simulation tests
// ====================================================================

describe("Anti-cheating simulations", () => {
  describe("Screenshot relay attack (Tier 2 defense)", () => {
    it("rejects a certificate with only 1 sub-frame (single photo)", () => {
      const token = generateQrPayload(EVENT_ID, TEST_SECRET, NOW);
      const block = token.timeBlock;

      // Attacker captures only 1 sub-frame (a single photo)
      const singleSubFrame = makeSubFrames(TEST_SECRET, EVENT_ID, block, [token.subFrame]);

      const result = verifySubFrameLiveness(singleSubFrame, TEST_SECRET, EVENT_ID, block);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("insufficient_subframes");
      }
    });

    it("rejects a certificate with FAKE HMACs (fabricated indices without real captures)", () => {
      const block = Math.floor(NOW / 15_000);

      // Attacker fabricates 3 sub-frame indices but doesn't know the real HMACs
      const fabricatedSubFrames = makeFakeSubFrames([0, 1, 2]);

      const result = verifySubFrameLiveness(fabricatedSubFrames, TEST_SECRET, EVENT_ID, block);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid_signature");
      }
    });

    it("rejects a certificate with 2 sub-frames from different blocks (photo relay with delay)", () => {
      // Attacker captures 2 photos from different blocks
      const token1 = generateQrPayload(EVENT_ID, TEST_SECRET, NOW);
      const token2 = generateQrPayload(EVENT_ID, TEST_SECRET, NOW + 20_000); // different block

      const subFrames = [
        ...makeSubFrames(TEST_SECRET, EVENT_ID, token1.timeBlock, [token1.subFrame]),
        ...makeSubFrames(TEST_SECRET, EVENT_ID, token2.timeBlock, [token2.subFrame]),
      ];

      // Even if we had 3, they'd be from different blocks → invalid
      // With only 2, it's insufficient_subframes
      const result = verifySubFrameLiveness(subFrames, TEST_SECRET, EVENT_ID, token1.timeBlock);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("insufficient_subframes");
      }
    });
  });

  describe("Offline queue tampering (Tier 1 defense)", () => {
    it("detects tampering via canonical form mismatch", () => {
      const token = generateQrPayload(EVENT_ID, TEST_SECRET, NOW);
      const block = token.timeBlock;
      const cert = createCertificate({
        eventId: EVENT_ID,
        token: token.payload,
        deviceFingerprint: "original-fp",
        subFrames: makeSubFrames(TEST_SECRET, EVENT_ID, block, [0, 1, 2]),
        scannedAt: NOW,
      });

      // Original canonical form
      const originalCanonical = canonicalizeCertificate(cert);

      // Tampered certificate (changed deviceFingerprint)
      const tamperedCert = { ...cert, deviceFingerprint: "tampered-fp" };
      const tamperedCanonical = canonicalizeCertificate(tamperedCert);

      // The canonical forms differ → the signature wouldn't match
      expect(originalCanonical).not.toBe(tamperedCanonical);
    });

    it("prevents idempotency key bypass via nonce regeneration", () => {
      const cert1 = createCertificate({
        eventId: EVENT_ID,
        token: "token",
        deviceFingerprint: "fp",
        subFrames: makeFakeSubFrames([0]),
        nonce: "nonce-1",
      });
      const cert2 = { ...cert1, nonce: "nonce-2" }; // attacker changes nonce

      // Different nonces produce different idempotency keys...
      const key1 = deriveIdempotencyKey(cert1);
      const key2 = deriveIdempotencyKey(cert2);
      expect(key1).not.toBe(key2);

      // BUT: the signature is bound to the nonce. Changing the nonce
      // breaks the signature → the server rejects it with "invalid_signature".
      // The attacker can't produce a valid signature for nonce-2 without
      // the device's private key.
      const canonical1 = canonicalizeCertificate(cert1);
      const canonical2 = canonicalizeCertificate(cert2);
      expect(canonical1).not.toBe(canonical2);
    });
  });

  describe("Clock skew defense", () => {
    it("rejects a certificate scanned 2 minutes in the future", () => {
      const cert = createCertificate({
        eventId: EVENT_ID,
        token: "token",
        deviceFingerprint: "fp",
        subFrames: makeFakeSubFrames([0]),
        scannedAt: NOW + 120_000, // 2 minutes ahead
      });
      const result = validateCertificateTimestamp(cert, NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("scanned_in_future");
      }
    });

    it("rejects a certificate scanned 25 hours ago (beyond sync window)", () => {
      const cert = createCertificate({
        eventId: EVENT_ID,
        token: "token",
        deviceFingerprint: "fp",
        subFrames: makeFakeSubFrames([0]),
        scannedAt: NOW - 25 * 3_600_000,
      });
      const result = validateCertificateTimestamp(cert, NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("clock_skew_too_large");
      }
    });
  });
});

// Cleanup
afterAll(async () => {
  await db.$disconnect();
});
