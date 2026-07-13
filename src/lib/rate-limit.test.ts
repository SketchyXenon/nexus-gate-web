import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("rate-limit presets + checkRateLimitByKey", () => {
  beforeEach(() => {
    vi.resetModules();
    // Ensure Upstash is NOT configured so we use the in-memory backend.
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("new presets exist with correct limits", async () => {
    const { rateLimit } = await import("@/lib/rate-limit");
    // passkeyOptions: 30/min
    let r = await rateLimit("test-key-options-1", "passkeyOptions");
    expect(r.allowed).toBe(true);
    // passkeyVerify: 10/min
    r = await rateLimit("test-key-verify-1", "passkeyVerify");
    expect(r.allowed).toBe(true);
    // passkeyAccount: 5/min
    r = await rateLimit("test-key-acct-1", "passkeyAccount");
    expect(r.allowed).toBe(true);
    // loginAccount: 5/min
    r = await rateLimit("test-key-login-acct-1", "loginAccount");
    expect(r.allowed).toBe(true);
  });

  it("passkeyOptions allows up to 30 then blocks", async () => {
    const { rateLimit } = await import("@/lib/rate-limit");
    const key = "passkey-options-exhaust";
    let allowed = 0;
    for (let i = 0; i < 30; i++) {
      const r = await rateLimit(key, "passkeyOptions");
      if (r.allowed) allowed++;
    }
    expect(allowed).toBe(30);
    const blocked = await rateLimit(key, "passkeyOptions");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("passkeyAccount allows up to 5 then blocks (the user_id checkpoint)", async () => {
    const { rateLimit } = await import("@/lib/rate-limit");
    const key = "acct:abc123";
    let allowed = 0;
    for (let i = 0; i < 5; i++) {
      const r = await rateLimit(key, "passkeyAccount");
      if (r.allowed) allowed++;
    }
    expect(allowed).toBe(5);
    const blocked = await rateLimit(key, "passkeyAccount");
    expect(blocked.allowed).toBe(false);
  });

  it("loginAccount allows up to 5 then blocks", async () => {
    const { rateLimit } = await import("@/lib/rate-limit");
    const key = "acct:login-xyz";
    let allowed = 0;
    for (let i = 0; i < 5; i++) {
      const r = await rateLimit(key, "loginAccount");
      if (r.allowed) allowed++;
    }
    expect(allowed).toBe(5);
    const blocked = await rateLimit(key, "loginAccount");
    expect(blocked.allowed).toBe(false);
  });

  it("different keys are independent (per-account isolation)", async () => {
    const { rateLimit } = await import("@/lib/rate-limit");
    // Exhaust account A
    for (let i = 0; i < 5; i++) {
      await rateLimit("acct:A", "passkeyAccount");
    }
    // Account B is unaffected
    const b = await rateLimit("acct:B", "passkeyAccount");
    expect(b.allowed).toBe(true);
  });

  it("checkRateLimitByKey returns null when allowed, NextResponse-like when blocked", async () => {
    const { checkRateLimitByKey } = await import("@/lib/api");
    const key = "acct:checkkey-test";
    // First 5 allowed
    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimitByKey(key, "passkeyAccount");
      expect(r).toBeNull();
    }
    // 6th blocked
    const blocked = await checkRateLimitByKey(key, "passkeyAccount");
    expect(blocked).not.toBeNull();
    expect(blocked?.status).toBe(429);
  });

  // ---- Edge cases for the user_id checkpoint ----

  it("loginAccount and passkeyAccount are independent presets (same account, separate buckets)", async () => {
    const { checkRateLimitByKey } = await import("@/lib/api");
    const acctId = "acct-independence-test";
    // Exhaust loginAccount (5) — checkRateLimitByKey prefixes the key with
    // the preset name, so the buckets are separate.
    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimitByKey(acctId, "loginAccount");
      expect(r).toBeNull();
    }
    // 6th loginAccount is blocked
    const blocked = await checkRateLimitByKey(acctId, "loginAccount");
    expect(blocked).not.toBeNull();
    // passkeyAccount for the same account is still allowed (separate bucket)
    const pk = await checkRateLimitByKey(acctId, "passkeyAccount");
    expect(pk).toBeNull();
  });

  it("rate limit window resets after the configured period (memory backend)", async () => {
    const { rateLimit } = await import("@/lib/rate-limit");
    // Use a unique key and vi.useFakeTimers to advance time.
    vi.useFakeTimers();
    const key = "acct:window-reset-test";
    for (let i = 0; i < 5; i++) {
      await rateLimit(key, "passkeyAccount");
    }
    // 6th is blocked
    let blocked = await rateLimit(key, "passkeyAccount");
    expect(blocked.allowed).toBe(false);
    // Advance 61 seconds (window is 60s)
    vi.advanceTimersByTime(61_000);
    // Now allowed again
    let after = await rateLimit(key, "passkeyAccount");
    expect(after.allowed).toBe(true);
    vi.useRealTimers();
  });
});
