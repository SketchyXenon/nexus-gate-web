import { describe, it, expect } from "vitest";
import {
  isEventVisibleToStudent,
  isEventVisibleToOrganizer,
  isEventVisibleToRole,
  studentNeedsProfile,
} from "./event-visibility";

// ====================================================================
// Unit tests for the STRICT event visibility predicate (v7).
//
// STRICT RULE for students:
//   1. OPEN TO ALL (both targetProgram AND targetSection null) → visible
//   2. EXACT program + section match → visible
//   3. Everything else (including program-wide events) → HIDDEN
// ====================================================================

describe("isEventVisibleToStudent — STRICT rule (v7)", () => {
  // ---- Rule 1: Open-to-all events ----
  describe("Rule 1 — Open-to-all events (both targets null)", () => {
    it("visible to a student with a complete profile", () => {
      expect(
        isEventVisibleToStudent({
          targetProgram: null,
          targetSection: null,
          studentProgram: "BSIT",
          studentSection: "1-A",
        })
      ).toBe(true);
    });

    it("visible to a student with NO profile", () => {
      expect(
        isEventVisibleToStudent({
          targetProgram: null,
          targetSection: null,
          studentProgram: null,
          studentSection: null,
        })
      ).toBe(true);
    });

    it("visible regardless of student's program/section", () => {
      for (const program of ["BSIT", "BSMx", "BIT-CT"]) {
        for (const section of ["1-A", "2-B", null]) {
          expect(
            isEventVisibleToStudent({
              targetProgram: null,
              targetSection: null,
              studentProgram: program,
              studentSection: section,
            })
          ).toBe(true);
        }
      }
    });
  });

  // ---- Rule 2: EXACT program + section match ----
  describe("Rule 2 — EXACT program + section match", () => {
    it("visible when program AND section match exactly", () => {
      expect(
        isEventVisibleToStudent({
          targetProgram: "BSIT",
          targetSection: "1-A",
          studentProgram: "BSIT",
          studentSection: "1-A",
        })
      ).toBe(true);
    });

    it("HIDDEN when program matches but section does NOT", () => {
      expect(
        isEventVisibleToStudent({
          targetProgram: "BSIT",
          targetSection: "1-A",
          studentProgram: "BSIT",
          studentSection: "2-B",
        })
      ).toBe(false);
    });

    it("HIDDEN when section matches but program does NOT", () => {
      expect(
        isEventVisibleToStudent({
          targetProgram: "BSIT",
          targetSection: "1-A",
          studentProgram: "BSMx",
          studentSection: "1-A",
        })
      ).toBe(false);
    });

    it("HIDDEN when neither matches", () => {
      expect(
        isEventVisibleToStudent({
          targetProgram: "BSIT",
          targetSection: "1-A",
          studentProgram: "BSMx",
          studentSection: "2-B",
        })
      ).toBe(false);
    });

    it("HIDDEN when student has no program/section set", () => {
      expect(
        isEventVisibleToStudent({
          targetProgram: "BSIT",
          targetSection: "1-A",
          studentProgram: null,
          studentSection: null,
        })
      ).toBe(false);
    });

    it("HIDDEN when student has program but no section", () => {
      expect(
        isEventVisibleToStudent({
          targetProgram: "BSIT",
          targetSection: "1-A",
          studentProgram: "BSIT",
          studentSection: null,
        })
      ).toBe(false);
    });
  });

  // ---- Program-wide events are now HIDDEN (stricter than v6) ----
  describe("Program-wide events (targetSection null, targetProgram set) — HIDDEN", () => {
    it("HIDDEN even when program matches", () => {
      // This is the KEY change from v6: program-wide events are no longer
      // visible to students. They must be open-to-all OR exact section matches.
      expect(
        isEventVisibleToStudent({
          targetProgram: "BSIT",
          targetSection: null,
          studentProgram: "BSIT",
          studentSection: "1-A",
        })
      ).toBe(false);
    });

    it("HIDDEN when program doesn't match", () => {
      expect(
        isEventVisibleToStudent({
          targetProgram: "BSIT",
          targetSection: null,
          studentProgram: "BSMx",
          studentSection: "1-A",
        })
      ).toBe(false);
    });
  });

  // ---- Section-only events (unusual config) — HIDDEN under strict rule ----
  describe("Section-only events (targetProgram null, targetSection set) — HIDDEN", () => {
    it("HIDDEN even when section matches", () => {
      // Under the strict rule, only open-to-all or exact program+section
      // matches are visible. Section-only events don't qualify.
      expect(
        isEventVisibleToStudent({
          targetProgram: null,
          targetSection: "1-A",
          studentProgram: "BSIT",
          studentSection: "1-A",
        })
      ).toBe(false);
    });
  });

  // ---- Exhaustive matrix for a BSIT/1-A student ----
  describe("Exhaustive matrix — BSIT section 1-A student", () => {
    const student = { studentProgram: "BSIT", studentSection: "1-A" };

    const cases: Array<{
      name: string;
      event: { targetProgram: string | null; targetSection: string | null };
      expected: boolean;
    }> = [
      // Open-to-all → visible
      { name: "open-to-all", event: { targetProgram: null, targetSection: null }, expected: true },
      // Exact match → visible
      { name: "BSIT 1-A (exact)", event: { targetProgram: "BSIT", targetSection: "1-A" }, expected: true },
      // Program-wide → HIDDEN (stricter)
      { name: "BSIT program-wide", event: { targetProgram: "BSIT", targetSection: null }, expected: false },
      // Different section → HIDDEN
      { name: "BSIT 2-B", event: { targetProgram: "BSIT", targetSection: "2-B" }, expected: false },
      // Different program → HIDDEN
      { name: "BSMx 1-A", event: { targetProgram: "BSMx", targetSection: "1-A" }, expected: false },
      { name: "BSMx program-wide", event: { targetProgram: "BSMx", targetSection: null }, expected: false },
      // Section-only → HIDDEN
      { name: "section-only 1-A", event: { targetProgram: null, targetSection: "1-A" }, expected: false },
    ];

    for (const { name, event, expected } of cases) {
      it(`${expected ? "sees" : "does NOT see"} ${name}`, () => {
        expect(isEventVisibleToStudent({ ...event, ...student })).toBe(expected);
      });
    }
  });
});

// ====================================================================
// Organizer visibility tests
// ====================================================================
describe("isEventVisibleToOrganizer", () => {
  const organizer = { studentProgram: "BSIT", studentSection: "1-A" };

  it("sees open-to-all events", () => {
    expect(
      isEventVisibleToOrganizer({ targetProgram: null, targetSection: null, ...organizer })
    ).toBe(true);
  });

  it("sees program-wide events in their program (for QR delegation)", () => {
    expect(
      isEventVisibleToOrganizer({ targetProgram: "BSIT", targetSection: null, ...organizer })
    ).toBe(true);
  });

  it("sees exact program+section matches", () => {
    expect(
      isEventVisibleToOrganizer({ targetProgram: "BSIT", targetSection: "1-A", ...organizer })
    ).toBe(true);
  });

  it("does NOT see program-wide events in a DIFFERENT program", () => {
    expect(
      isEventVisibleToOrganizer({ targetProgram: "BSMx", targetSection: null, ...organizer })
    ).toBe(false);
  });

  it("does NOT see exact matches in a different program", () => {
    expect(
      isEventVisibleToOrganizer({ targetProgram: "BSMx", targetSection: "1-A", ...organizer })
    ).toBe(false);
  });

  it("with no program set, only sees open-to-all", () => {
    const org = { studentProgram: null, studentSection: null };
    expect(isEventVisibleToOrganizer({ targetProgram: null, targetSection: null, ...org })).toBe(true);
    expect(isEventVisibleToOrganizer({ targetProgram: "BSIT", targetSection: null, ...org })).toBe(false);
  });
});

// ====================================================================
// Role-aware dispatcher tests
// ====================================================================
describe("isEventVisibleToRole", () => {
  const input = {
    targetProgram: "BSIT" as string | null,
    targetSection: "1-A" as string | null,
    studentProgram: "BSIT" as string | null,
    studentSection: "1-A" as string | null,
  };

  it("ADMIN sees ALL events (no filtering)", () => {
    // Admin sees open-to-all, exact match, program-wide, and even
    // events targeting other programs.
    expect(isEventVisibleToRole("ADMIN", { ...input, targetProgram: null, targetSection: null })).toBe(true);
    expect(isEventVisibleToRole("ADMIN", { ...input })).toBe(true);
    expect(isEventVisibleToRole("ADMIN", { ...input, targetProgram: "BSMx", targetSection: "2-B" })).toBe(true);
    expect(isEventVisibleToRole("ADMIN", { ...input, targetProgram: "BSIT", targetSection: null })).toBe(true);
  });

  it("ORGANIZER uses the organizer rule", () => {
    expect(isEventVisibleToRole("ORGANIZER", { ...input, targetProgram: null, targetSection: null })).toBe(true);
    expect(isEventVisibleToRole("ORGANIZER", { ...input })).toBe(true);
    expect(isEventVisibleToRole("ORGANIZER", { ...input, targetProgram: "BSIT", targetSection: null })).toBe(true);
    expect(isEventVisibleToRole("ORGANIZER", { ...input, targetProgram: "BSMx", targetSection: null })).toBe(false);
  });

  it("USER uses the strict student rule", () => {
    expect(isEventVisibleToRole("USER", { ...input, targetProgram: null, targetSection: null })).toBe(true);
    expect(isEventVisibleToRole("USER", { ...input })).toBe(true);
    // Program-wide → HIDDEN for students (strict)
    expect(isEventVisibleToRole("USER", { ...input, targetProgram: "BSIT", targetSection: null })).toBe(false);
    // Different section → HIDDEN
    expect(isEventVisibleToRole("USER", { ...input, targetSection: "2-B" })).toBe(false);
  });
});

// ====================================================================
// studentNeedsProfile tests
// ====================================================================
describe("studentNeedsProfile", () => {
  it("returns true when BOTH program and section are null", () => {
    expect(studentNeedsProfile(null, null)).toBe(true);
  });

  it("returns true when program is null but section is set", () => {
    expect(studentNeedsProfile(null, "1-A")).toBe(true);
  });

  it("returns true when program is set but section is null", () => {
    expect(studentNeedsProfile("BSIT", null)).toBe(true);
  });

  it("returns false when BOTH program and section are set", () => {
    expect(studentNeedsProfile("BSIT", "1-A")).toBe(false);
  });
});
