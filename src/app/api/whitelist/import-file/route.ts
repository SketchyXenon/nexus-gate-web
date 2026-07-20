import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseFile } from "@/lib/file-parser";
import { requireAuth, checkRateLimitByKey } from "@/lib/api";
import { audit } from "@/lib/audit";

// Allow up to 30s for large file parsing (PDF/Excel with many rows).
export const maxDuration = 30;

// ====================================================================
// POST /api/whitelist/import-file (ORGANIZER+)
// --------------------------------------------------------------------
// Accepts a file upload (Excel, PDF, DOCX, CSV) and parses it into
// student records. Returns the parsed students for preview before
// the user confirms the import.
//
// The actual import (database write) happens via the existing
// POST /api/whitelist endpoint with the parsed students.
//
// Request: multipart/form-data with "file" field
// Response: { students, errors, totalRows, skipped }
// ====================================================================
export async function POST(req: NextRequest) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;

  // Tighter rate limit for file upload + heavy parsing (5/min).
  // Excel/PDF/DOCX parsing is CPU-intensive; without this an admin could
  // upload 100 10MB files/min, exhausting the serverless CPU budget.
  // Fails CLOSED on limiter error.
  const importRl = await checkRateLimitByKey(account.id, "whitelistImportFile");
  if (importRl) return importRl;

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // File size limit: 10MB
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: "File too large (max 10MB)" },
        { status: 400 },
      );
    }

    // Sanitize filename: extract just the extension, ignore path components.
    const safeName =
      (file.name || "").split("/").pop()?.split("\\").pop() || "upload";

    // ---- STRICT file extension validation (server-side, cannot be bypassed) ----
    // Only allow: .xlsx, .xls, .pdf, .docx, .csv
    const ALLOWED_EXTENSIONS = new Set(["xlsx", "xls", "pdf", "docx", "csv"]);
    const ext = safeName.toLowerCase().split(".").pop() || "";
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return NextResponse.json(
        {
          error: `File type ".${ext}" is not allowed. Supported types: .xlsx, .xls, .pdf, .docx, .csv`,
          code: "INVALID_FILE_TYPE",
        },
        { status: 400 },
      );
    }

    // ---- MIME type validation (defense-in-depth) ----
    const ALLOWED_MIME_TYPES = new Set([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
      "application/vnd.ms-excel", // .xls
      "application/pdf", // .pdf
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
      "text/csv", // .csv
      "application/octet-stream", // fallback (some browsers send this for unknown types)
      "application/vnd.ms-excel.sheet.macroEnabled.12", // .xlsm (treated as .xls)
    ]);
    if (file.type && !ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        {
          error: `MIME type "${file.type}" is not allowed.`,
          code: "INVALID_MIME_TYPE",
        },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await parseFile(buffer, safeName);

    await audit({
      actorId: account.id,
      action: "whitelist.file_parsed",
      targetType: "Whitelist",
      metadata: {
        filename: safeName,
        fileSize: file.size,
        totalRows: result.totalRows,
        parsed: result.students.length,
        skipped: result.skipped,
        errors: result.errors.length,
      },
      req,
    });

    return NextResponse.json(result);
  } catch (e) {
    // Parse errors should return 400 (bad request), not 500 (server error).
    // This prevents information leakage via stack traces and is the correct
    // HTTP semantic for "we couldn't process your file."
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: `File processing failed: ${msg}`, code: "PARSE_ERROR" },
      { status: 400 },
    );
  }
}
