// ====================================================================
// Nexus Gate — Event visibility predicate (pure logic, unit-tested)
// ====================================================================
// This module exports pure functions that encapsulate the STRICT
// course/section alignment rule used by GET /api/events,
// GET /api/dashboard, and the admin/organizer dashboards.
//
// STRICT RULE (v7):
//   An event is visible to a student if and only if ONE of the following
//   is true:
//
//     1. OPEN TO ALL — both targetProgram AND targetSection are null
//        (a true department-wide / school-wide event).
//
//     2. EXACT COURSE+SECTION MATCH — the event's targetProgram equals
//        the student's program AND the event's targetSection equals the
//        student's section. BOTH must match exactly.
//
//   Program-wide events (targetProgram set, targetSection null) are
//   HIDDEN from students — the event must target the student's EXACT
//   course + section combination, OR be open to everyone.
//
//   If the student hasn't set their program/section, they can ONLY see
//   open-to-all events. The frontend shows a "complete your profile"
//   prompt in that case.
//
// ROLE AWARENESS:
//   - ADMIN: sees ALL events (no filtering).
//   - ORGANIZER: sees all events in their OWN program (program-wide
//     visibility for projection delegation), plus open-to-all events,
//     plus exact-section matches.
//   - USER: subject to the strict rule above.
// ====================================================================

export interface EventVisibilityInput {
  // The event's targeting criteria. `null` means "open to everyone"
  // for that dimension.
  targetProgram: string | null;
  targetSection: string | null;
  // The student's profile. `null` means "not set yet".
  studentProgram: string | null;
  studentSection: string | null;
}

/**
 * STRICT visibility predicate for USER (student) accounts.
 *
 * @returns `true` if the event is visible to the student, `false` otherwise.
 */
export function isEventVisibleToStudent(input: EventVisibilityInput): boolean {
  const { targetProgram, targetSection, studentProgram, studentSection } = input;

  // Rule 1: Open to ALL — both target fields null.
  if (targetProgram === null && targetSection === null) {
    return true;
  }

  // Rule 2: EXACT course + section match.
  // The event must target the student's EXACT program AND section.
  // Program-wide events (targetSection null but targetProgram set) are
  // HIDDEN — the event must be specific to the student's section.
  if (targetProgram !== null && targetSection !== null) {
    // Student must have set BOTH program and section.
    if (studentProgram === null || studentSection === null) return false;
    // Exact match required on BOTH dimensions.
    return targetProgram === studentProgram && targetSection === studentSection;
  }

  // Any other configuration (program-wide with null section, or
  // section-only with null program) is HIDDEN from students under the
  // strict rule. Only open-to-all or exact program+section matches
  // are visible.
  return false;
}

/**
 * Visibility predicate for ORGANIZER accounts.
 *
 * Organizers can see:
 *   1. Open-to-all events (for projection/QR delegation).
 *   2. Events in their OWN program (any section — so they can project
 *      QR codes for delegated events in their program).
 *   3. Events that exactly match their program + section.
 *
 * This is broader than the student rule because organizers need to
 * project QR codes for events they don't own but are in their program.
 */
export function isEventVisibleToOrganizer(input: EventVisibilityInput): boolean {
  const { targetProgram, targetSection, studentProgram, studentSection } = input;

  // Rule 1: Open to ALL.
  if (targetProgram === null && targetSection === null) {
    return true;
  }

  // If the organizer hasn't set their program, they can only see
  // open-to-all events.
  if (studentProgram === null) return false;

  // Rule 2: Program-wide event in the organizer's program → visible.
  if (targetProgram === studentProgram && targetSection === null) {
    return true;
  }

  // Rule 3: Exact program + section match → visible.
  if (
    targetProgram === studentProgram &&
    targetSection !== null &&
    studentSection !== null &&
    targetSection === studentSection
  ) {
    return true;
  }

  return false;
}

/**
 * Role-aware visibility dispatcher. Admins see everything; organizers
 * use the organizer rule; users use the strict student rule.
 *
 * @param role - "ADMIN" | "ORGANIZER" | "USER"
 * @param input - the event + student profile
 * @returns `true` if the event is visible to the given role.
 */
export function isEventVisibleToRole(
  role: "ADMIN" | "ORGANIZER" | "USER",
  input: EventVisibilityInput
): boolean {
  // Admins see ALL events (no filtering).
  if (role === "ADMIN") return true;
  if (role === "ORGANIZER") return isEventVisibleToOrganizer(input);
  return isEventVisibleToStudent(input);
}

/**
 * Determine whether a student needs to complete their profile (program +
 * section) before they can see course-specific events.
 *
 * Returns `true` if EITHER program OR section is missing.
 */
export function studentNeedsProfile(studentProgram: string | null, studentSection: string | null): boolean {
  return studentProgram === null || studentSection === null;
}
