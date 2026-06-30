// ====================================================================
// Nexus Gate — Programs (College of Technology, CTU Danao)
// ====================================================================

export interface Program {
  code: string;
  label: string;
}

export const PROGRAMS: Program[] = [
  { code: "BSIT", label: "Bachelor of Science in Information Technology" },
  { code: "BSMx", label: "Bachelor of Science in Mechatronics" },
  { code: "BIT-CT", label: "BIT — Computer Technology" },
  { code: "BIT-DT", label: "BIT — Drafting Technology" },
  { code: "BIT-ET", label: "BIT — Electrical Technology" },
  { code: "BIT-ELT", label: "BIT — Electronics Technology" },
];

export const PROGRAM_CODES = new Set(PROGRAMS.map((p) => p.code));

export function getProgramLabel(code: string): string | null {
  return PROGRAMS.find((p) => p.code === code)?.label ?? null;
}

export function getProgramCodes(): string[] {
  return PROGRAMS.map((p) => p.code);
}
