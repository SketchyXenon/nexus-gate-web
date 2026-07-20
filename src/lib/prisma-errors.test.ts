import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { isUniqueConstraintError } from "./prisma-errors";

// Unit tests for the Prisma error classifier.
// Guards against the fragile string-match pattern it replaces.

describe("isUniqueConstraintError", () => {
  it("returns true for a Prisma P2002 known-request error", () => {
    const err = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the constraint: `event_attendance_eventId_accountId_key`",
      { code: "P2002", clientVersion: "6.11.1" },
    );
    expect(isUniqueConstraintError(err)).toBe(true);
  });

  it("returns false for a Prisma error with a different code (e.g. P2025 record not found)", () => {
    const err = new Prisma.PrismaClientKnownRequestError(
      "An operation failed because it depends on one or more records that were required but not found.",
      { code: "P2025", clientVersion: "6.11.1" },
    );
    expect(isUniqueConstraintError(err)).toBe(false);
  });

  it("returns false for a plain Error whose message happens to contain 'Unique constraint'", () => {
    // This is the regression guard: the old string-match would have
    // returned true here, incorrectly. The code-based check does not.
    const err = new Error("Unique constraint failed (but this is not a Prisma error)");
    expect(isUniqueConstraintError(err)).toBe(false);
  });

  it("returns false for null/undefined/non-object values", () => {
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError(undefined)).toBe(false);
    expect(isUniqueConstraintError("Unique constraint")).toBe(false);
    expect(isUniqueConstraintError({ code: "P2002" })).toBe(false); // not a Prisma instance
  });
});
