// ====================================================================
// Nexus Gate — Year/Section consistency validation (pure, unit-tested)
// ====================================================================
// Sections MUST follow the format "<year>-<letter>", e.g. "1-A", "2-B".
// This is a STRICT requirement — "2" or "A" alone are NOT valid.
// This module enforces both the FORMAT and the year-consistency.
// ====================================================================

// Strict regex: one or more digits, a hyphen, one or more letters
const SECTION_FORMAT_REGEX = /^\d+-[A-Za-z]+$/;

/**
 * Validate that a section string is in the correct format: "<number>-<letter>".
 * Examples: "1-A" → true, "2-B" → true, "10-AB" → true
 * "2" → false, "A" → false, "2A" → false, "2-A-B" → false
 */
export function isValidSectionFormat(section: string): boolean {
  return SECTION_FORMAT_REGEX.test(section.trim());
}

/**
 * Extract the leading numeric prefix from a section string.
 * For "3-A" → "3", for "2-B" → "2", for "A" → null (invalid format).
 */
export function extractSectionYear(section: string): string | null {
  const match = section.trim().match(/^(\d+)-/);
  return match ? match[1] : null;
}

/**
 * Validate that a section's numeric prefix matches the given year.
 * Also validates the section FORMAT (must be "<number>-<letter>").
 *
 * @param year    - The year level (1-4).
 * @param section - The section string (e.g. "3-A", "2-B").
 * @returns `true` only if:
 *   - The section is in valid "<number>-<letter>" format, AND
 *   - The numeric prefix matches the year.
 */
export function isYearSectionConsistent(
  year: number,
  section: string,
): boolean {
  // First check the format — "2" or "A" alone are NOT valid
  if (!isValidSectionFormat(section)) return false;
  const sectionYear = extractSectionYear(section);
  if (sectionYear === null) return false;
  return sectionYear === String(year);
}

/**
 * Human-readable explanation of the year/section consistency rule.
 * Used by both the API error message and the frontend hint text.
 */
export const YEAR_SECTION_MISMATCH_MESSAGE = (year: number, section: string) =>
  `Year ${year} and section "${section}" don't match. The section should start with your year level (e.g. "${year}-A" for Year ${year}).`;
