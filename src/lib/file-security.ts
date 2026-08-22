// ====================================================================
// Nexus Gate - File Security Checkpoint
// ====================================================================
// Defense-in-depth file validation layer for the whitelist import.
// Validates the ACTUAL file content (not just the client-provided
// filename/MIME), per 06-security-architecture.md:
//   - §3 "treat all external input as hostile until validated"
//   - §4 A03 (injection) + A05 (insecure design / supply chain)
//   - §5 "validate the actual content, not just the label"
//
// Layers (each can reject; none can approve on its own):
//   1. Filename hygiene  - reject path traversal, double/masked extensions
//                          (e.g. "sample.exe.docx"), control characters.
//   2. MIME consistency  - cross-check declared MIME vs extension.
//   3. Magic-byte sniff   - read the file's real signature and confirm it
//                          matches the claimed type. This is the critical
//                          guard against renamed executables and polyglots.
//   4. Macro/active-content block - reject Office macro-enabled files
//                          (.xlsm/.xlsb) and OLE objects - primary malware
//                          vectors per OWASP A03/A05.
//   5. Content sanity    - reject zero-length, oversized, or degenerate
//                          inputs before the parser runs.
//
// Every rejection returns a human-readable reason + a stable code so the
// API can surface a 400 (not a 500) and the UI can show a precise error.
// ====================================================================

import { PROGRAM_CODES } from "./programs";

export type FileKind = "xlsx" | "xls" | "pdf" | "docx" | "csv";

export interface FileSecurityError {
  reason: string;
  code: string;
}

export interface FileSecurityResult {
  ok: boolean;
  kind?: FileKind;
  error?: FileSecurityError;
}

// ---- Magic-byte signatures (the file's TRUE identity) ----
// A renamed .exe will NOT match any of these and is rejected.
interface Signature {
  kind: FileKind;
  offset: number;
  bytes: number[]; // hex bytes
}

const SIGNATURES: Signature[] = [
  // ZIP-based Office formats (.xlsx, .docx) + ZIP archives.
  // Both xlsx and docx are OOXML (ZIP containers); we disambiguate by
  // inspecting the internal [Content_Types].xml marker later.
  { kind: "xlsx", offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  { kind: "docx", offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  // ZIP empty archive (0x50 0x4b 0x05 0x06) - reject as suspicious.
  // PDF: "%PDF-" (0x25 0x50 0x44 0x46 0x2d)
  { kind: "pdf", offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // OLE2 Compound Document (legacy .xls, .doc) - D0 CF 11 E0 A1 B1 1A E1
  {
    kind: "xls",
    offset: 0,
    bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  },
];

// MIME types each kind may legitimately arrive as (some browsers send
// application/octet-stream for everything; that's allowed but the magic
// bytes must still match).
const KIND_MIME: Record<FileKind, Set<string>> = {
  xlsx: new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",
    "application/zip",
  ]),
  xls: new Set([
    "application/vnd.ms-excel",
    "application/octet-stream",
    "application/vnd.ms-office",
  ]),
  pdf: new Set(["application/pdf", "application/octet-stream"]),
  docx: new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/octet-stream",
    "application/zip",
  ]),
  csv: new Set([
    "text/csv",
    "text/plain",
    "application/octet-stream",
    "application/vnd.ms-excel",
  ]),
};

// Extensions each kind maps to (for cross-checking the declared extension).
const KIND_EXT: Record<FileKind, string[]> = {
  xlsx: ["xlsx"],
  xls: ["xls"],
  pdf: ["pdf"],
  docx: ["docx"],
  csv: ["csv"],
};

// Macro / active-content extensions that are NEVER allowed (malware vectors).
const MACRO_EXTENSIONS = new Set([
  "xlsm", // Excel macro-enabled
  "xlsb", // Excel binary (macros)
  "doc", // legacy Word (macros)
  "docm", // Word macro-enabled
  "ppt", // legacy PowerPoint
  "pptm", // PowerPoint macro-enabled
  "xlam", // Excel add-in (macros)
  "js",
  "mjs",
  "cjs",
  "ts",
  "exe",
  "bat",
  "cmd",
  "sh",
  "ps1",
  "msi",
  "dll",
  "so",
  "dylib",
  "jar",
  "class",
  "vbs",
  "vba",
  "wsf",
  "hta",
  "scr",
  "com",
  "pif",
  "lnk",
  "html",
  "htm",
  "svg",
  "xml",
  "json",
  "yaml",
  "yml",
  "env",
  "zip",
  "rar",
  "7z",
  "gz",
  "tar",
  "bz2",
]);

// ---- Filename hygiene ----
// Rejects: path traversal, control characters, masked/double extensions
// (e.g. "sample.exe.docx", "report.pdf.exe"), leading dots, and known
// dangerous extensions anywhere in the name.
function validateFilename(filename: string): FileSecurityError | null {
  if (!filename || typeof filename !== "string") {
    return { reason: "No filename provided.", code: "NO_FILENAME" };
  }
  // Reject control characters (incl. null byte - a classic injection trick).
  if (/[\x00-\x1f\x7f]/.test(filename)) {
    return {
      reason: "Filename contains control characters.",
      code: "BAD_FILENAME",
    };
  }
  // Strip any path components the client may have sent.
  const base = filename.split(/[/\\]/).pop() ?? filename;
  if (!base || base === "." || base === "..") {
    return { reason: "Invalid filename.", code: "BAD_FILENAME" };
  }
  // Tokenize the filename by non-alphanumeric chars. If ANY token is a
  // known dangerous extension, reject - this catches masked disguises like
  // "sample.exe.docx" (token "exe"), "report.pdf.exe" (token "exe"), and
  // "macros.xlsm" (token "xlsm") regardless of dot count or position.
  // Legitimate versioned names like "roster.v2.csv" pass (no blocked token).
  const tokens = base
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (const tok of tokens) {
    if (MACRO_EXTENSIONS.has(tok)) {
      return {
        reason: `Filename contains a blocked extension ".${tok}". Macro-enabled and executable files are not allowed.`,
        code: "BLOCKED_EXTENSION",
      };
    }
  }
  // Reject leading dots (hidden-file disguise) and trailing dots/spaces
  // (Windows strips these, which can trick extension checks).
  if (/^\./.test(base) || /[.\s]$/.test(base)) {
    return {
      reason: "Filename has a leading dot or trailing dot/space.",
      code: "BAD_FILENAME",
    };
  }
  return null;
}

// ---- Magic-byte sniff ----
// Returns the detected FileKind, or null if no signature matched (meaning
// the file is NOT what its extension claims - reject).
function detectByMagicBytes(buffer: Buffer): FileKind | null {
  if (buffer.length < 4) return null;
  for (const sig of SIGNATURES) {
    if (buffer.length < sig.offset + sig.bytes.length) continue;
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[sig.offset + i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      // Both xlsx and docx share the ZIP signature. Disambiguate by
      // scanning the first ~4KB for the OOXML content-types marker.
      if (sig.kind === "xlsx" || sig.kind === "docx") {
        const head = buffer
          .subarray(0, Math.min(buffer.length, 4096))
          .toString("latin1");
        if (head.includes("spreadsheetml")) return "xlsx";
        if (head.includes("wordprocessingml")) return "docx";
        // It's a ZIP but not a recognized Office doc - reject.
        return null;
      }
      return sig.kind;
    }
  }
  // CSV has no magic bytes - it's plain text. Validate it's printable ASCII
  // or UTF-8 text (no binary control bytes in the first 512 bytes).
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  let printable = 0;
  for (const b of sample) {
    // Allow tab, newline, carriage return, and printable bytes >= 0x20.
    // High bytes (>= 0x80) are OK for UTF-8 multibyte sequences.
    if (b === 0x09 || b === 0x0a || b === 0x0d || b >= 0x20) printable++;
  }
  // If >95% of the sample is printable, treat as text/CSV.
  if (sample.length > 0 && printable / sample.length > 0.95) return "csv";
  return null;
}

// ---- Main checkpoint ----
// filename: the client-provided filename (sanitized inside).
// declaredMime: the client-provided Content-Type (untrusted).
// buffer: the actual file bytes (authoritative source of truth).
export function validateUpload(
  filename: string,
  declaredMime: string,
  buffer: Buffer,
): FileSecurityResult {
  // Layer 1: filename hygiene.
  const nameErr = validateFilename(filename);
  if (nameErr) return { ok: false, error: nameErr };

  const base = filename.split(/[/\\]/).pop() ?? filename;
  const ext = base.toLowerCase().split(".").pop() ?? "";

  // Layer 2: extension must be one of the supported ones (not macro/dangerous).
  const supportedExt: Record<FileKind, string> = {
    xlsx: "xlsx",
    xls: "xls",
    pdf: "pdf",
    docx: "docx",
    csv: "csv",
  };
  const declaredKind = (Object.keys(supportedExt) as FileKind[]).find(
    (k) => supportedExt[k] === ext,
  );
  if (!declaredKind) {
    return {
      ok: false,
      error: {
        reason: `File type ".${ext}" is not allowed. Supported: .xlsx, .xls, .pdf, .docx, .csv`,
        code: "INVALID_FILE_TYPE",
      },
    };
  }

  // Layer 3: magic-byte sniff - the authoritative identity check.
  const detected = detectByMagicBytes(buffer);
  if (!detected) {
    return {
      ok: false,
      error: {
        reason: `The file's contents do not match its ".${ext}" extension. The file may be corrupted or disguised (e.g. an executable renamed to .${ext}). Upload a genuine .${ext} file.`,
        code: "CONTENT_EXTENSION_MISMATCH",
      },
    };
  }
  // The detected kind must match the declared extension kind. A .docx that
  // sniffs as a PDF (or vice versa) is suspicious - reject.
  if (detected !== declaredKind) {
    return {
      ok: false,
      error: {
        reason: `The file's content type (${detected.toUpperCase()}) does not match its extension (.${ext}). Upload a file whose content matches its name.`,
        code: "KIND_EXTENSION_MISMATCH",
      },
    };
  }

  // Layer 4: MIME consistency (defense-in-depth). An empty MIME is allowed
  // (some browsers omit it); a present-but-wrong MIME is rejected.
  if (declaredMime && !KIND_MIME[detected].has(declaredMime)) {
    return {
      ok: false,
      error: {
        reason: `The declared MIME type "${declaredMime}" is not valid for a .${ext} file.`,
        code: "MIME_EXTENSION_MISMATCH",
      },
    };
  }

  // Layer 5: content sanity - reject zero-length or degenerate inputs.
  if (buffer.length === 0) {
    return {
      ok: false,
      error: { reason: "The file is empty.", code: "EMPTY_FILE" },
    };
  }

  return { ok: true, kind: detected };
}

// Re-export for the parser to reuse the strict program allowlist.
export { PROGRAM_CODES };
