// ====================================================================
// Nexus Gate — File Parser (Excel, PDF, DOCX → Student Records)
// ====================================================================
// Parses uploaded files containing student roster data.
// Supports:
//   • Excel (.xlsx, .xls) — via xlsx library
//   • PDF (.pdf) — via pdf-parse (extracts text, then parses rows)
//   • DOCX (.docx) — via mammoth (extracts text, then parses rows)
//   • CSV (.csv) — via papaparse (already supported)
//
// Expected columns (any order, headers auto-detected):
//   studentId | student_id | id  → 7-digit number
//   email                     → valid email
//   fullName | full_name | name → student's full name
//   program                   → BSIT, BSMx, BIT-CT, BIT-DT, BIT-ET, BIT-ELT
//   section                   → e.g. "2-B"
// ====================================================================

import * as XLSX from "xlsx";
import { PROGRAM_CODES } from "./programs";

export interface ParsedStudent {
  studentId: number;
  email: string;
  fullName: string;
  program: string;
  section: string;
}

export interface ParseResult {
  students: ParsedStudent[];
  errors: string[];
  totalRows: number;
  skipped: number;
}

// ---- Column name normalization ----
function normalizeHeader(h: string): string {
  return h.toLowerCase().trim().replace(/[\s_-]+/g, "");
}

const HEADER_MAP: Record<string, string> = {
  studentid: "studentId",
  id: "studentId",
  studentnumber: "studentId",
  number: "studentId",
  email: "email",
  emailaddress: "email",
  fullname: "fullName",
  name: "fullName",
  studentname: "fullName",
  program: "program",
  course: "program",
  department: "program",
  section: "section",
  block: "section",
  group: "section",
};

// ---- Parse a raw 2D array of rows into ParsedStudent[] ----
function parseRows(data: unknown[][]): ParseResult {
  const errors: string[] = [];
  const students: ParsedStudent[] = [];
  let skipped = 0;

  if (data.length === 0) {
    return { students, errors: ["File is empty"], totalRows: 0, skipped: 0 };
  }

  // Detect header row
  const firstRow = data[0].map((c) => String(c || "").trim());
  const hasHeaders = firstRow.some((c) => {
    const norm = normalizeHeader(c);
    return HEADER_MAP[norm] !== undefined;
  });

  let headers: string[] = [];
  let dataStart = 0;

  if (hasHeaders) {
    headers = firstRow.map((c) => HEADER_MAP[normalizeHeader(c)] || c);
    dataStart = 1;
  } else {
    // No headers — assume order: studentId, email, fullName, program, section
    headers = ["studentId", "email", "fullName", "program", "section"];
  }

  // Validate required columns exist
  const requiredCols = ["studentId", "email", "fullName"];
  for (const req of requiredCols) {
    if (!headers.includes(req)) {
      errors.push(`Missing required column: ${req}. Expected columns: studentId, email, fullName, program, section`);
      return { students, errors, totalRows: data.length - dataStart, skipped };
    }
  }

  // Parse data rows
  for (let i = dataStart; i < data.length; i++) {
    const row = data[i];
    if (!row || row.every((c) => !c || String(c).trim() === "")) {
      skipped++;
      continue;
    }

    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = String(row[idx] || "").trim();
    });

    // Parse student ID
    const sidStr = (obj.studentId || "").replace(/\D/g, "");
    const studentId = parseInt(sidStr, 10);
    if (!studentId || studentId < 1000000 || studentId > 9999999) {
      errors.push(`Row ${i + 1}: Invalid student ID "${obj.studentId}" (must be 7 digits)`);
      skipped++;
      continue;
    }

    // Parse email
    const email = (obj.email || "").toLowerCase().trim();
    if (!email || !email.includes("@")) {
      errors.push(`Row ${i + 1}: Invalid email "${obj.email}"`);
      skipped++;
      continue;
    }

    // Parse full name
    const fullName = (obj.fullName || "").trim();
    if (!fullName || fullName.length < 2) {
      errors.push(`Row ${i + 1}: Invalid name "${obj.fullName}"`);
      skipped++;
      continue;
    }

    // Parse program (optional — validate if provided)
    let program = (obj.program || "").trim();
    if (program && !PROGRAM_CODES.has(program)) {
      errors.push(`Row ${i + 1}: Invalid program "${program}" (must be one of: ${[...PROGRAM_CODES].join(", ")})`);
      skipped++;
      continue;
    }

    // Parse section (optional)
    const section = (obj.section || "").trim();

    students.push({ studentId, email, fullName, program, section });
  }

  return { students, errors, totalRows: data.length - dataStart, skipped };
}

// ---- Excel parser (.xlsx, .xls) ----
export function parseExcel(buffer: Buffer): ParseResult {
  try {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return { students: [], errors: ["No sheets found in Excel file"], totalRows: 0, skipped: 0 };
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false }) as unknown[][];
    return parseRows(data);
  } catch (e) {
    return { students: [], errors: [`Failed to parse Excel: ${e instanceof Error ? e.message : String(e)}`], totalRows: 0, skipped: 0 };
  }
}

// ---- PDF parser (.pdf) ----
export async function parsePdf(buffer: Buffer): Promise<ParseResult> {
  try {
    // pdf-parse v2 is ESM-only and exports { PDFParse } as a named class
    // (no default export). Instantiate with { data } and call .getText().
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const data = await parser.getText();
    const text = data.text;
    try {
      await parser.destroy();
    } catch {
      // ignore cleanup errors
    }

    // Try to detect tabular data in the PDF text
    // PDFs often have rows separated by newlines, columns by spaces/tabs
    const lines = text.split("\n").filter((l) => l.trim());

    // Try to detect columns by looking for patterns:
    // 7-digit number, email, name, program, section
    const rows: unknown[][] = [];
    let headers: string[] | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Try splitting by tabs first, then multiple spaces
      let parts = trimmed.split("\t").map((p) => p.trim());
      if (parts.length < 3) {
        parts = trimmed.split(/\s{2,}/).map((p) => p.trim());
      }
      if (parts.length < 3) {
        // Try comma separation
        parts = trimmed.split(",").map((p) => p.trim());
      }

      if (parts.length >= 3) {
        // Check if this looks like a header row
        const normalized = parts.map((p) => normalizeHeader(p));
        if (normalized.some((n) => HEADER_MAP[n])) {
          headers = parts.map((p) => HEADER_MAP[normalizeHeader(p)] || p);
          continue;
        }
        rows.push(parts);
      }
    }

    if (headers) {
      // Re-parse with detected headers
      const dataWithHeaders = [headers, ...rows] as unknown[][];
      return parseRows(dataWithHeaders);
    }

    // No headers detected — try default column order
    return parseRows(rows);
  } catch (e) {
    return { students: [], errors: [`Failed to parse PDF: ${e instanceof Error ? e.message : String(e)}`], totalRows: 0, skipped: 0 };
  }
}

// ---- DOCX parser (.docx) ----
export async function parseDocx(buffer: Buffer): Promise<ParseResult> {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value;

    // Similar to PDF — extract rows from text
    const lines = text.split("\n").filter((l) => l.trim());
    const rows: unknown[][] = [];
    let headers: string[] | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parts = trimmed.split("\t").map((p) => p.trim());
      if (parts.length < 3) {
        parts = trimmed.split(/\s{2,}/).map((p) => p.trim());
      }
      if (parts.length < 3) {
        parts = trimmed.split(",").map((p) => p.trim());
      }

      if (parts.length >= 3) {
        const normalized = parts.map((p) => normalizeHeader(p));
        if (normalized.some((n) => HEADER_MAP[n])) {
          headers = parts.map((p) => HEADER_MAP[normalizeHeader(p)] || p);
          continue;
        }
        rows.push(parts);
      }
    }

    if (headers) {
      const dataWithHeaders = [headers, ...rows] as unknown[][];
      return parseRows(dataWithHeaders);
    }

    return parseRows(rows);
  } catch (e) {
    return { students: [], errors: [`Failed to parse DOCX: ${e instanceof Error ? e.message : String(e)}`], totalRows: 0, skipped: 0 };
  }
}

// ---- Main entry point: detect file type and parse ----
export async function parseFile(buffer: Buffer, filename: string): Promise<ParseResult> {
  const ext = filename.toLowerCase().split(".").pop();

  switch (ext) {
    case "xlsx":
    case "xls":
      return parseExcel(buffer);
    case "pdf":
      return await parsePdf(buffer);
    case "docx":
      return await parseDocx(buffer);
    case "csv":
      // CSV is handled by the existing papaparse flow on the client side
      // But if we receive it server-side, parse with xlsx (it handles CSV too)
      return parseExcel(buffer);
    default:
      return {
        students: [],
        errors: [`Unsupported file type: .${ext}. Supported: .xlsx, .xls, .pdf, .docx, .csv`],
        totalRows: 0,
        skipped: 0,
      };
  }
}
