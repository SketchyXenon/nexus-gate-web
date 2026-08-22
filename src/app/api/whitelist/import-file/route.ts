import { NextRequest, NextResponse } from "next/server";
import { parseFile } from "@/lib/file-parser";
import { validateUpload } from "@/lib/file-security";
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
// SECURITY CHECKPOINT (file-security.ts validateUpload) runs BEFORE the
// parser and validates the file's ACTUAL content (magic bytes), not just
// the client-provided filename/MIME. This blocks:
//   - renamed executables ("sample.exe" -> "sample.docx")
//   - masked/double extensions ("malware.exe.docx")
//   - macro-enabled Office files (.xlsm/.xlsb)
//   - MIME/extension mismatches
//   - polyglot files whose content doesn't match their label
// See 06-security-architecture.md §3 (treat input as hostile), §4 A03/A05.
//
// The actual import (database write) happens via POST /api/whitelist with
// the parsed students.
//
// Request: multipart/form-data with "file" field
// Response: { students, errors, totalRows, skipped }
// ====================================================================
export async function POST(req: NextRequest) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;

  // Tighter rate limit for file upload + heavy parsing (5/min).
  const importRl = await checkRateLimitByKey(account.id, "whitelistImportFile");
  if (importRl) return importRl;

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // File size limit: 10MB (checked early to avoid reading huge payloads).
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: "File too large (max 10MB)", code: "TOO_LARGE" },
        { status: 400 },
      );
    }

    // Read the bytes ONCE - the security checkpoint and the parser share it.
    const buffer = Buffer.from(await file.arrayBuffer());

    // ---- SECURITY CHECKPOINT ----
    // Validates filename hygiene + extension + MIME + magic bytes + content
    // sanity. The magic-byte sniff is the authoritative identity check: a
    // renamed .exe will NOT match any signature and is rejected here.
    const security = validateUpload(file.name, file.type || "", buffer);
    if (!security.ok || !security.kind) {
      const err = security.error!;
      return NextResponse.json(
        { error: err.reason, code: err.code },
        { status: 400 },
      );
    }

    // Pass the verified kind to the parser so it dispatches on the SNIFFED
    // type (authoritative) rather than the (untrusted) filename extension.
    const result = await parseFile(buffer, security.kind);

    await audit({
      actorId: account.id,
      action: "whitelist.file_parsed",
      targetType: "Whitelist",
      metadata: {
        filename: file.name.split(/[/\\]/).pop() || "upload",
        fileSize: file.size,
        detectedKind: security.kind,
        totalRows: result.totalRows,
        parsed: result.students.length,
        skipped: result.skipped,
        errors: result.errors.length,
      },
      req,
    });

    return NextResponse.json(result);
  } catch (e) {
    // Parse errors return 400 (bad request), not 500. The message is
    // generic (no stack trace) to avoid information leakage.
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: `File processing failed: ${msg}`, code: "PARSE_ERROR" },
      { status: 400 },
    );
  }
}
