import { describe, it, expect } from "vitest";
import { isCooldownExpired, daysUntilCooldownExpires, COOLDOWN_MS } from "./cooldown";

// ====================================================================
// Unit tests for the 30-day cooldown logic.
// Used by both the profile update and password change routes.
// ====================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

describe("isCooldownExpired", () => {
  // ---- Never changed (null) → expired (allowed) ----
  it("returns true when lastChangedAt is null (never changed)", () => {
    expect(isCooldownExpired(null)).toBe(true);
  });

  // ---- Exactly at the cooldown boundary ----
  it("returns true when exactly 30 days have passed (boundary)", () => {
    const now = Date.now();
    const lastChanged = new Date(now - COOLDOWN_MS);
    expect(isCooldownExpired(lastChanged, now)).toBe(true);
  });

  // ---- Just over 30 days ----
  it("returns true when more than 30 days have passed", () => {
    const now = Date.now();
    const lastChanged = new Date(now - COOLDOWN_MS - 1); // 1ms over
    expect(isCooldownExpired(lastChanged, now)).toBe(true);
  });

  // ---- Just under 30 days → NOT expired ----
  it("returns false when 29 days have passed (still in cooldown)", () => {
    const now = Date.now();
    const lastChanged = new Date(now - 29 * DAY_MS);
    expect(isCooldownExpired(lastChanged, now)).toBe(false);
  });

  // ---- Just changed (0 days ago) → NOT expired ----
  it("returns false when just changed (0 days ago)", () => {
    const now = Date.now();
    const lastChanged = new Date(now);
    expect(isCooldownExpired(lastChanged, now)).toBe(false);
  });

  // ---- 1 second ago → NOT expired ----
  it("returns false when changed 1 second ago", () => {
    const now = Date.now();
    const lastChanged = new Date(now - 1000);
    expect(isCooldownExpired(lastChanged, now)).toBe(false);
  });

  // ---- 15 days ago (halfway) → NOT expired ----
  it("returns false when 15 days have passed (halfway through cooldown)", () => {
    const now = Date.now();
    const lastChanged = new Date(now - 15 * DAY_MS);
    expect(isCooldownExpired(lastChanged, now)).toBe(false);
  });

  // ---- Future timestamp edge case → NOT expired (safety) ----
  it("returns false when lastChangedAt is in the future (clock skew safety)", () => {
    const now = Date.now();
    const lastChanged = new Date(now + DAY_MS); // 1 day in the future
    expect(isCooldownExpired(lastChanged, now)).toBe(false);
  });
});

describe("daysUntilCooldownExpires", () => {
  // ---- Never changed → 0 days ----
  it("returns 0 when lastChangedAt is null", () => {
    expect(daysUntilCooldownExpires(null)).toBe(0);
  });

  // ---- Just changed → ~30 days ----
  it("returns ~30 when just changed", () => {
    const now = Date.now();
    const lastChanged = new Date(now);
    const days = daysUntilCooldownExpires(lastChanged, now);
    expect(days).toBe(30); // ceil((30 days - 0) / 1 day) = 30
  });

  // ---- 1 day ago → ~29 days ----
  it("returns 30 when 1 day has passed (ceil rounds up)", () => {
    const now = Date.now();
    const lastChanged = new Date(now - 1 * DAY_MS);
    const days = daysUntilCooldownExpires(lastChanged, now);
    // 30 days - 1 day = 29 days, but ceil(29 days + a few ms / 1 day) = 30
    expect(days).toBeGreaterThanOrEqual(29);
    expect(days).toBeLessThanOrEqual(30);
  });

  // ---- 15 days ago → ~15 days ----
  it("returns ~15 when 15 days have passed", () => {
    const now = Date.now();
    const lastChanged = new Date(now - 15 * DAY_MS);
    const days = daysUntilCooldownExpires(lastChanged, now);
    expect(days).toBeGreaterThanOrEqual(15);
    expect(days).toBeLessThanOrEqual(16);
  });

  // ---- 29 days ago → ~1 day ----
  it("returns ~1 when 29 days have passed", () => {
    const now = Date.now();
    const lastChanged = new Date(now - 29 * DAY_MS);
    const days = daysUntilCooldownExpires(lastChanged, now);
    expect(days).toBeGreaterThanOrEqual(1);
    expect(days).toBeLessThanOrEqual(2);
  });

  // ---- Exactly 30 days → 0 (expired) ----
  it("returns 0 when exactly 30 days have passed (expired)", () => {
    const now = Date.now();
    const lastChanged = new Date(now - COOLDOWN_MS);
    expect(daysUntilCooldownExpires(lastChanged, now)).toBe(0);
  });

  // ---- Over 30 days → 0 (expired) ----
  it("returns 0 when more than 30 days have passed (expired)", () => {
    const now = Date.now();
    const lastChanged = new Date(now - 31 * DAY_MS);
    expect(daysUntilCooldownExpires(lastChanged, now)).toBe(0);
  });

  // ---- Never returns negative ----
  it("never returns a negative number", () => {
    const now = Date.now();
    // Test various timestamps
    for (const offsetMs of [0, 1000, DAY_MS, 15 * DAY_MS, 29 * DAY_MS, COOLDOWN_MS, 31 * DAY_MS, 60 * DAY_MS]) {
      const lastChanged = new Date(now - offsetMs);
      const days = daysUntilCooldownExpires(lastChanged, now);
      expect(days).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("COOLDOWN_MS constant", () => {
  it("is exactly 30 days in milliseconds", () => {
    expect(COOLDOWN_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("equals 2,592,000,000 ms", () => {
    expect(COOLDOWN_MS).toBe(2_592_000_000);
  });
});
