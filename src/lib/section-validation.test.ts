import { describe, it, expect } from "vitest";
import {
  extractSectionYear,
  isYearSectionConsistent,
  YEAR_SECTION_MISMATCH_MESSAGE,
} from "./section-validation";

// ====================================================================
// Unit tests for the year/section consistency validation.
// Sections follow the format "<year>-<letter>", e.g. "1-A", "2-B".
// The numeric prefix of the section must match the selected year level.
// ====================================================================

describe("extractSectionYear", () => {
  it("extracts the leading number from a standard section", () => {
    expect(extractSectionYear("1-A")).toBe("1");
    expect(extractSectionYear("2-B")).toBe("2");
    expect(extractSectionYear("3-C")).toBe("3");
    expect(extractSectionYear("4-D")).toBe("4");
    expect(extractSectionYear("5-E")).toBe("5");
  });

  it("extracts the number even with extra whitespace", () => {
    expect(extractSectionYear("  2-B  ")).toBe("2");
    expect(extractSectionYear(" 3-A")).toBe("3");
  });

  it("returns null for a section with no numeric prefix", () => {
    expect(extractSectionYear("A")).toBeNull();
    expect(extractSectionYear("B")).toBeNull();
    expect(extractSectionYear("Section A")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractSectionYear("")).toBeNull();
    expect(extractSectionYear("   ")).toBeNull();
  });

  it("extracts only the leading number (not embedded numbers)", () => {
    expect(extractSectionYear("1-A2")).toBe("1");
    expect(extractSectionYear("2-B3")).toBe("2");
  });

  it("handles multi-digit prefixes (though unusual)", () => {
    // Unusual but we should handle it gracefully
    expect(extractSectionYear("12-A")).toBe("12");
  });
});

describe("isYearSectionConsistent", () => {
  // ---- Consistent combinations ----
  describe("consistent combinations (should return true)", () => {
    const consistent: Array<[number, string]> = [
      [1, "1-A"],
      [1, "1-B"],
      [1, "1-C"],
      [2, "2-A"],
      [2, "2-B"],
      [3, "3-A"],
      [3, "3-C"],
      [4, "4-D"],
      [5, "5-E"],
    ];

    for (const [year, section] of consistent) {
      it(`Year ${year} + section "${section}" is consistent`, () => {
        expect(isYearSectionConsistent(year, section)).toBe(true);
      });
    }
  });

  // ---- Inconsistent combinations (should return false) ----
  describe("inconsistent combinations (should return false)", () => {
    const inconsistent: Array<[number, string]> = [
      [1, "2-A"], // Year 1 with Year 2's section
      [1, "2-B"],
      [2, "1-A"], // Year 2 with Year 1's section
      [2, "3-C"],
      [3, "2-B"], // The example from the user's requirement
      [3, "1-A"],
      [4, "3-D"],
      [5, "4-E"],
    ];

    for (const [year, section] of inconsistent) {
      it(`Year ${year} + section "${section}" is INCONSISTENT`, () => {
        expect(isYearSectionConsistent(year, section)).toBe(false);
      });
    }
  });

  // ---- v10: Invalid section formats (no number-letter pattern) → REJECTED ----
  describe("invalid section formats (no number-letter pattern — rejected)", () => {
    const invalidFormats: Array<[number, string]> = [
      [1, "A"],
      [2, "B"],
      [3, "C"],
      [1, "Section A"],
      [2, "Gold"],
    ];

    for (const [year, section] of invalidFormats) {
      it(`Year ${year} + section "${section}" (invalid format) is rejected`, () => {
        expect(isYearSectionConsistent(year, section)).toBe(false);
      });
    }
  });

  // ---- Edge cases: whitespace ----
  describe("whitespace handling", () => {
    it("trims whitespace before checking", () => {
      expect(isYearSectionConsistent(2, "  2-B  ")).toBe(true);
      expect(isYearSectionConsistent(2, "  3-B  ")).toBe(false);
    });
  });

  // ---- Exhaustive matrix for Year 3 ----
  describe("exhaustive matrix — Year 3 student", () => {
    const year = 3;
    const cases: Array<{ section: string; expected: boolean; reason: string }> = [
      { section: "3-A", expected: true, reason: "matches year" },
      { section: "3-B", expected: true, reason: "matches year" },
      { section: "3-C", expected: true, reason: "matches year" },
      { section: "2-A", expected: false, reason: "year 2 prefix" },
      { section: "2-B", expected: false, reason: "year 2 prefix (the user's example)" },
      { section: "1-A", expected: false, reason: "year 1 prefix" },
      { section: "4-A", expected: false, reason: "year 4 prefix" },
      { section: "5-A", expected: false, reason: "year 5 prefix" },
      // v10: Invalid formats (no number-letter pattern) are now rejected
      { section: "A", expected: false, reason: "invalid format (no number)" },
      { section: "B", expected: false, reason: "invalid format (no number)" },
    ];

    for (const { section, expected, reason } of cases) {
      it(`"${section}" → ${expected ? "consistent" : "INCONSISTENT"} (${reason})`, () => {
        expect(isYearSectionConsistent(year, section)).toBe(expected);
      });
    }
  });
});

describe("YEAR_SECTION_MISMATCH_MESSAGE", () => {
  it("produces a human-readable error message", () => {
    const msg = YEAR_SECTION_MISMATCH_MESSAGE(3, "2-B");
    expect(msg).toContain("3");
    expect(msg).toContain("2-B");
    expect(msg).toMatch(/don't match/i);
  });

  it("includes a helpful example in the message", () => {
    const msg = YEAR_SECTION_MISMATCH_MESSAGE(2, "1-A");
    expect(msg).toContain("2-A");
    expect(msg).toContain("Year 2");
  });

  it("works for all year levels", () => {
    for (const year of [1, 2, 3, 4, 5]) {
      const msg = YEAR_SECTION_MISMATCH_MESSAGE(year, `${year === 5 ? 1 : year +1}-A`);
      expect(msg).toContain(String(year));
      expect(msg).toMatch(/don't match/i);
    }
  });
});
