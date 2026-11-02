// ====================================================================
// Nexus Gate - Event Target Audience Resolution
// --------------------------------------------------------------------
// PURE, dependency-free logic shared by the cron reminder creator
// (src/app/api/cron/event-reminders/route.ts). Kept out of the route
// file so it can be unit-tested exhaustively (vitest, tests/) without
// booting Next or a database - targeting bugs silently swallow
// notifications, so every combination deserves an edge-case test.
//
// SEMANTICS (hardening pass 2026-11-02 - M3 fix):
// Event.targetProgram / targetSection are INDEPENDENTLY nullable
// (prisma: String? each), so four audience shapes exist:
//
//   program=null, section=null  -> open to ALL eligible students
//   program=X,    section=null  -> program-wide: every section in X
//   program=null, section=Y     -> section-wide: Y in every program
//   program=X,    section=Y     -> exact program+section match
//
// The previous reminder implementation handled only rows 1 and 4 and
// SILENTLY SKIPPED rows 2 and 3 - events targeted at "Program X, all
// sections" or "Section Y, all programs" never notified anyone.
//
// Matching is EXACT string equality (same semantics the events API and
// the attendance-eligibility checks use - see schema comments: program/
// section mirror Event.targetProgram/targetSection with both-null =
// untargeted). Case sensitivity is deliberate: program/section names
// are authored from fixed dropdowns, and loosening to case-insensitive
// here would diverge from the eligibility checks elsewhere.
// ====================================================================

/** Structural view of an event row (no Prisma import - test-friendly). */
export interface TargetingEvent {
  id: string | number;
  targetProgram: string | null;
  targetSection: string | null;
}

/** Structural view of an eligible student row. */
export interface TargetingStudent {
  id: string;
  program: string | null;
  section: string | null;
}

/**
 * Resolves the list of student account IDs eligible for `event`.
 * Returns DEDUPLICATED ids in first-seen order (students input is
 * expected unique already, but the Set guards against future callers
 * merging rosters).
 */
export function eligibleAccountIdsForEvent(
  event: TargetingEvent,
  students: readonly TargetingStudent[],
): string[] {
  const ids = new Set<string>();

  for (const student of students) {
    // Row 1: untargeted event - everyone.
    if (event.targetProgram === null && event.targetSection === null) {
      ids.add(student.id);
      continue;
    }
    // Row 4: exact program+section.
    if (
      event.targetProgram !== null &&
      event.targetSection !== null &&
      student.program === event.targetProgram &&
      student.section === event.targetSection
    ) {
      ids.add(student.id);
      continue;
    }
    // Row 2: program-wide (any section, including section-less students).
    if (
      event.targetProgram !== null &&
      event.targetSection === null &&
      student.program === event.targetProgram
    ) {
      ids.add(student.id);
      continue;
    }
    // Row 3: section-wide (any program, including program-less students).
    if (
      event.targetProgram === null &&
      event.targetSection !== null &&
      student.section === event.targetSection
    ) {
      ids.add(student.id);
      continue;
    }
    // Anything else: student does not match - excluded by falling out.
  }

  return Array.from(ids);
}
