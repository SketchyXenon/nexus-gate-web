// ====================================================================
// Nexus Gate - Event visibility predicate (pure logic, unit-tested)
// ====================================================================
// This module exports pure functions that encapsulate the course/section
// alignment rule used by GET /api/events, GET /api/dashboard, and the
// admin/organizer dashboards.
//
// VISIBILITY RULE (v8 - organizer events reach their students):
//   An event is visible to a student if and only if ONE of the following
//   is true:
//
//     1. OPEN TO ALL - both targetProgram AND targetSection are null
//        (a true department-wide / school-wide event).
//
//     2. PROGRAM-WIDE MATCH - the event's targetProgram equals the
//        student's program AND targetSection is null. This makes an
//        organizer's program-scoped event (no specific section) visible
//        to every student in that program.
//
//     3. EXACT COURSE+SECTION MATCH - targetProgram equals the student's
//        program AND targetSection equals the student's section.
//
//   v7 hid program-wide events from students, which silently broke the
//   organizer->student flow: organizers (faculty) usually have a program
//   but no section, so their academic events defaulted to program-wide
//   and were invisible to every student. v8 fixes that.
//
//   If the student hasn't set their program, they can ONLY see open-to-all
//   events. The frontend shows a "complete your profile" prompt in that case.
//
// ROLE AWARENESS:
//  - ADMIN: sees ALL events (no filtering).
//  - ORGANIZER: same rule as students (open-to-all, program-wide in their
//     program, or exact section match). QR delegation is governed separately
//     by /api/events/[id]/secret, not by list visibility.
//  - USER: subject to the rule above.
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
 * Visibility predicate for USER (student) accounts (v8).
 *
 * @returns `true` if the event is visible to the student, `false` otherwise.
 */
export function isEventVisibleToStudent(input: EventVisibilityInput): boolean {
  const { targetProgram, targetSection, studentProgram, studentSection } =
    input;

  // Rule 1: Open to ALL - both target fields null.
  if (targetProgram === null && targetSection === null) {
    return true;
  }

  // Events with no targetProgram are not open-to-all and have no program
  // to match against (e.g. section-only with null program) - hidden.
  if (targetProgram === null) return false;

  // Student must have set their program to see any program-scoped event.
  if (studentProgram === null) return false;
  if (targetProgram !== studentProgram) return false;

  // Rule 2: Program-wide (targetSection null) -> visible to whole program.
  if (targetSection === null) return true;

  // Rule 3: Exact program + section match.
  return studentSection !== null && targetSection === studentSection;
}

/**
 * Visibility predicate for ORGANIZER accounts.
 *
 * Organizers use the same visibility rule as students (v8): open-to-all,
 * program-wide in their own program, or exact program+section match.
 * Cross-organizer QR projection is authorized separately by
 * /api/events/[id]/secret (organization-tag + delegationEnabled), not by
 * list visibility, so the list rule does not need to be broader.
 */
export function isEventVisibleToOrganizer(
  input: EventVisibilityInput,
): boolean {
  return isEventVisibleToStudent(input);
}

/**
 * Role-aware visibility dispatcher. Admins see everything; organizers
 * and users use the v8 rule (open-to-all, program-wide, or exact match).
 *
 * @param role - "ADMIN" | "ORGANIZER" | "USER"
 * @param input - the event + student profile
 * @returns `true` if the event is visible to the given role.
 */
export function isEventVisibleToRole(
  role: "ADMIN" | "ORGANIZER" | "USER",
  input: EventVisibilityInput,
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
export function studentNeedsProfile(
  studentProgram: string | null,
  studentSection: string | null,
): boolean {
  return studentProgram === null || studentSection === null;
}

/**
 * Prisma WHERE fragment for the events a USER (student) or ORGANIZER may
 * see on lists/dashboards. Centralizes the v8 rule so every read path
 * (GET /api/events, GET /api/dashboard, GET /api/events/[id]) stays in
 * sync with isEventVisibleToStudent.
 *
 * Returns an `OR` array suitable for `where.OR` (or wrapping in AND).
 */
export function visibleEventWhereOr(
  studentProgram: string | null,
  studentSection: string | null,
): Record<string, unknown>[] {
  // Open-to-all is always visible.
  const or: Record<string, unknown>[] = [
    { targetProgram: null, targetSection: null },
  ];
  // Program-scoped events require a matching program.
  if (studentProgram) {
    // Program-wide (any section) -> whole program sees it.
    or.push({ targetProgram: studentProgram, targetSection: null });
    // Exact program + section match.
    if (studentSection) {
      or.push({ targetProgram: studentProgram, targetSection: studentSection });
    }
  }
  return or;
}
