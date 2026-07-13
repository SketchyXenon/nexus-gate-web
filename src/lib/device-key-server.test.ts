import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db module so we can test registerDeviceKey without a database.
vi.mock("@/lib/db", () => ({
  db: {
    deviceKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

import { computeFingerprint } from "./device-key-server";

// Sample Ed25519 JWK (x is a 32-byte base64url key — value is arbitrary but valid format).
const sampleJwk: JsonWebKey = {
  kty: "OKP",
  crv: "Ed25519",
  x: "11qYAYKuCrfvjDnliIfTRy2jB9828n8k6v1Q3e1NqMQ",
};

const mismatchedJwk: JsonWebKey = {
  kty: "OKP",
  crv: "Ed25519",
  x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

describe("computeFingerprint", () => {
  it("produces a 64-char hex string", async () => {
    const fp = await computeFingerprint(sampleJwk);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic (same key -> same fingerprint)", async () => {
    const a = await computeFingerprint(sampleJwk);
    const b = await computeFingerprint(sampleJwk);
    expect(a).toBe(b);
  });

  it("differs for different keys", async () => {
    const a = await computeFingerprint(sampleJwk);
    const b = await computeFingerprint(mismatchedJwk);
    expect(a).not.toBe(b);
  });
});

describe("registerDeviceKey — fingerprint binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when client-supplied fingerprint does not match the public key", async () => {
    const { registerDeviceKey } = await import("./device-key-server");
    const { db } = await import("@/lib/db");
    // findUnique should NOT be called — the fingerprint check fires first.
    const findUniqueSpy = vi.mocked(db.deviceKey.findUnique);

    const realFp = await computeFingerprint(sampleJwk);
    await expect(
      registerDeviceKey({
        accountId: "acct-1",
        publicKeyJwk: sampleJwk,
        // Supply a WRONG fingerprint (the one for mismatchedJwk, not sampleJwk).
        fingerprint: await computeFingerprint(mismatchedJwk),
      }),
    ).rejects.toThrow(/Fingerprint does not match/);

    expect(findUniqueSpy).not.toHaveBeenCalled();
    // Sanity: the real fingerprint would have been accepted (reaches findUnique).
    await registerDeviceKey({
      accountId: "acct-1",
      publicKeyJwk: sampleJwk,
      fingerprint: realFp,
    }).catch(() => {});
    expect(findUniqueSpy).toHaveBeenCalled();
  });
});
