import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, hmacSha256 } from "./auth";

// Unit tests for the auth helpers (bcrypt + HMAC).
// Supabase Auth handles sessions/tokens now; these tests cover the
// remaining bcrypt password wrappers and the HMAC helper used by QR tokens.

describe("hashPassword / verifyPassword", () => {
  it("hashes a password and verifies it correctly", async () => {
    const password = "MyStrongPass1";
    const hash = await hashPassword(password);
    expect(hash).not.toBe(password);
    expect(hash.length).toBeGreaterThan(20);
    const valid = await verifyPassword(password, hash);
    expect(valid).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("CorrectPass1");
    const valid = await verifyPassword("WrongPass1", hash);
    expect(valid).toBe(false);
  });

  it("produces DIFFERENT hashes for the same password (salt)", async () => {
    const h1 = await hashPassword("SamePass1");
    const h2 = await hashPassword("SamePass1");
    expect(h1).not.toBe(h2);
    expect(await verifyPassword("SamePass1", h1)).toBe(true);
    expect(await verifyPassword("SamePass1", h2)).toBe(true);
  });
});

describe("hmacSha256", () => {
  it("produces a deterministic hex digest", () => {
    const key = "test-key";
    const msg = "test-message";
    const h1 = hmacSha256(key, msg);
    const h2 = hmacSha256(key, msg);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different digests for different keys", () => {
    const msg = "test-message";
    expect(hmacSha256("key-a", msg)).not.toBe(hmacSha256("key-b", msg));
  });

  it("produces different digests for different messages", () => {
    const key = "test-key";
    expect(hmacSha256(key, "msg-a")).not.toBe(hmacSha256(key, "msg-b"));
  });
});
