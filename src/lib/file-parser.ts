// ====================================================================
// Nexus Gate — File Parser (Excel, PDF, DOCX → Student Records)
// ====================================================================
// Parses uploaded files containing student roster data.
// Supports:
//   • Excel (.xlsx, .xls) — via exceljs library (replaces xlsx which
//     had a prototype pollution vulnerability — CVSS 7.8)
//   • PDF (.pdf) — via pdfjs-dist (pure JS, no native deps — works on
//     Vercel serverless. Replaces pdf-parse which used @napi-rs/canvas)
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
  return h
    .toLowerCase()
    .trim()
    .replace(/[\s_-]+/g, "");
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
      errors.push(
        `Missing required column: ${req}. Expected columns: studentId, email, fullName, program, section`,
      );
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
      errors.push(
        `Row ${i + 1}: Invalid student ID "${obj.studentId}" (must be 7 digits)`,
      );
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
      errors.push(
        `Row ${i + 1}: Invalid program "${program}" (must be one of: ${[...PROGRAM_CODES].join(", ")})`,
      );
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
// Uses exceljs instead of xlsx (which had a prototype pollution CVE).
export async function parseExcel(buffer: Buffer): Promise<ParseResult> {
  try {
    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer.buffer as ArrayBuffer);

    const sheet = workbook.worksheets[0];
    if (!sheet) {
      return {
        students: [],
        errors: ["No sheets found in Excel file"],
        totalRows: 0,
        skipped: 0,
      };
    }

    // Convert sheet rows to a 2D array for the shared parseRows function.
    const data: unknown[][] = [];
    sheet.eachRow((row) => {
      const values = row.values as unknown[];
      // exceljs uses 1-based indexing; slice(1) removes the leading null.
      data.push(values.slice(1).map((v) => (v == null ? "" : v)));
    });

    return parseRows(data);
  } catch (e) {
    return {
      students: [],
      errors: [
        `Failed to parse Excel: ${e instanceof Error ? e.message : String(e)}`,
      ],
      totalRows: 0,
      skipped: 0,
    };
  }
}

// ---- PDF parser (.pdf) ----
// Uses pdfjs-dist (pure JavaScript, no native dependencies).
// Works on Vercel serverless (unlike pdf-parse which needed @napi-rs/canvas).
export async function parsePdf(buffer: Buffer): Promise<ParseResult> {
  try {
    // pdfjs-dist needs a fake DOMMatrix/DOMRect polyfill in Node.
    // We provide minimal stubs that pdfjs doesn't actually use for
    // text-only extraction.
    if (typeof globalThis.DOMMatrix === "undefined") {
      (globalThis as Record<string, unknown>).DOMMatrix = class {
        constructor() {}
        scale() {
          return this;
        }
        translate() {
          return this;
        }
        rotate() {
          return this;
        }
      };
    }
    if (typeof globalThis.DOMRect === "undefined") {
      (globalThis as Record<string, unknown>).DOMRect = class {};
    }

    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(buffer);
    const doc = await pdfjs.getDocument({ data }).promise;
    let text = "";

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // Join text items, inserting newlines for block-level breaks.
      const pageText = content.items
        .map((item) => {
          if ("str" in item) {
            return item.str + ("hasEOL" in item && item.hasEOL ? "\n" : " ");
          }
          return "";
        })
        .join("");
      text += pageText + "\n";
    }

    try {
      await doc.cleanup();
    } catch {
      // ignore cleanup errors
    }

    // Try to detect tabular data in the PDF text.
    const lines = text.split("\n").filter((l) => l.trim());
    const rows: unknown[][] = [];
    let headers: string[] | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Try splitting by tabs first, then multiple spaces.
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
    return {
      students: [],
      errors: [
        `Failed to parse PDF: ${e instanceof Error ? e.message : String(e)}`,
      ],
      totalRows: 0,
      skipped: 0,
    };
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
    return {
      students: [],
      errors: [
        `Failed to parse DOCX: ${e instanceof Error ? e.message : String(e)}`,
      ],
      totalRows: 0,
      skipped: 0,
    };
  }
}

// ---- CSV parser (.csv) ----
// Uses papaparse for reliable CSV parsing.
export async function parseCsv(buffer: Buffer): Promise<ParseResult> {
  try {
    const Papa = (await import("papaparse")).default;
    const text = buffer.toString("utf-8");
    const result = Papa.parse(text, { skipEmptyLines: true });
    const data = result.data as unknown[][];
    return parseRows(data);
  } catch (e) {
    return {
      students: [],
      errors: [
        `Failed to parse CSV: ${e instanceof Error ? e.message : String(e)}`,
      ],
      totalRows: 0,
      skipped: 0,
    };
  }
}

// ---- Main entry point: detect file type and parse ----
export async function parseFile(
  buffer: Buffer,
  filename: string,
): Promise<ParseResult> {
  const ext = filename.toLowerCase().split(".").pop();

  switch (ext) {
    case "xlsx":
    case "xls":
      return await parseExcel(buffer);
    case "pdf":
      return await parsePdf(buffer);
    case "docx":
      return await parseDocx(buffer);
    case "csv":
      // CSV is handled by the existing papaparse flow on the client side.
      // Server-side, use papaparse (synchronous parse).
      return await parseCsv(buffer);
    default:
      return {
        students: [],
        errors: [
          `Unsupported file type: .${ext}. Supported: .xlsx, .xls, .pdf, .docx, .csv`,
        ],
        totalRows: 0,
        skipped: 0,
      };
  }
}
