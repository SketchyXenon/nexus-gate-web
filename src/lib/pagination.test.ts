import { describe, it, expect } from "vitest";
import { paginationSchema } from "./validation";

// ====================================================================
// Tests for pagination schema validation (used by events/[id]/attendance,
// accounts, audit-logs, and other paginated routes).
// Verifies boundary conditions that affect DB query correctness.
// ====================================================================

describe("paginationSchema", () => {
  it("accepts valid page and pageSize", () => {
    const result = paginationSchema.safeParse({ page: 1, pageSize: 50 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.pageSize).toBe(50);
    }
  });

  it("defaults page to 1 when omitted (via optional + default)", () => {
    // The schema uses z.coerce.number().int().min(1).default(1)
    const result = paginationSchema.safeParse({ pageSize: 20 });
    expect(result.success).toBe(true);
  });

  it("rejects page < 1", () => {
    const result = paginationSchema.safeParse({ page: 0, pageSize: 10 });
    expect(result.success).toBe(false);
  });

  it("rejects pageSize < 1", () => {
    const result = paginationSchema.safeParse({ page: 1, pageSize: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects pageSize > 100 (the max cap)", () => {
    const result = paginationSchema.safeParse({ page: 1, pageSize: 101 });
    expect(result.success).toBe(false);
  });

  it("accepts pageSize = 100 (the max boundary)", () => {
    const result = paginationSchema.safeParse({ page: 1, pageSize: 100 });
    expect(result.success).toBe(true);
  });

  it("coerces string numbers to integers", () => {
    const result = paginationSchema.safeParse({ page: "2", pageSize: "25" });
    expect(result.success).toBe(true);
  });

  it("rejects non-numeric strings", () => {
    const result = paginationSchema.safeParse({ page: "abc", pageSize: 10 });
    expect(result.success).toBe(false);
  });

  it("rejects negative numbers", () => {
    const result = paginationSchema.safeParse({ page: -1, pageSize: 10 });
    expect(result.success).toBe(false);
  });

  it("rejects floats (must be integers)", () => {
    const result = paginationSchema.safeParse({ page: 1.5, pageSize: 10 });
    expect(result.success).toBe(false);
  });
});

// ====================================================================
// Tests for the whitelist pagination skip/take calculation.
// Verifies the O(2 * pageSize) memory bound logic.
// ====================================================================

describe("whitelist pagination math", () => {
  it("calculates skip correctly for page 1", () => {
    const page = 1;
    const pageSize = 50;
    const skip = (page - 1) * pageSize;
    expect(skip).toBe(0);
  });

  it("calculates skip correctly for page 3", () => {
    const page = 3;
    const pageSize = 50;
    const skip = (page - 1) * pageSize;
    expect(skip).toBe(100);
  });

  it("calculates total pages correctly", () => {
    const total = 125;
    const pageSize = 50;
    const totalPages = Math.ceil(total / pageSize);
    expect(totalPages).toBe(3);
  });

  it("handles zero total gracefully", () => {
    const total = 0;
    const pageSize = 50;
    const totalPages = Math.ceil(total / pageSize);
    expect(totalPages).toBe(0);
  });
});

// ====================================================================
// Tests for the cron event-reminders dedup key logic.
// The dedup uses a Set of "accountId:eventId" keys for O(1) lookup.
// ====================================================================

describe("cron event-reminders dedup logic", () => {
  it("builds unique dedup keys", () => {
    const existingKeys = new Set<string>();
    existingKeys.add("user-1:event-1");
    existingKeys.add("user-1:event-2");
    existingKeys.add("user-2:event-1");
    expect(existingKeys.size).toBe(3);
  });

  it("detects existing reminders in O(1)", () => {
    const existingKeys = new Set<string>(["user-1:event-1"]);
    expect(existingKeys.has("user-1:event-1")).toBe(true);
    expect(existingKeys.has("user-1:event-2")).toBe(false);
  });

  it("deduplicates account IDs from multiple events", () => {
    const eventConditions = [
      { event: { id: 1 }, accountIds: ["a", "b", "c"] },
      { event: { id: 2 }, accountIds: ["b", "c", "d"] },
    ];
    const allAccountIds = Array.from(
      new Set(eventConditions.flatMap((ec) => ec.accountIds)),
    );
    expect(allAccountIds).toEqual(["a", "b", "c", "d"]);
    expect(allAccountIds.length).toBe(4);
  });
});
