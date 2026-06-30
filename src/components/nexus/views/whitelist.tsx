"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { motion, AnimatePresence } from "framer-motion";
import {
  Upload,
  Users,
  Search,
  Trash2,
  FileSpreadsheet,
  CheckCircle2,
  Loader2,
  ClipboardPaste,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  X,
  Info,
  Download,
  Clock,
  FileText,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useWhitelist,
  useImportWhitelist,
  useDeleteWhitelist,
  useMe,
  type AuthorizedStudent,
  type WhitelistSort,
} from "@/lib/api-client";
import { PROGRAMS, getProgramLabel } from "@/lib/programs";
import { toast } from "@/hooks/use-toast";
import { ConfirmDialog } from "@/components/nexus/confirm-dialog";

interface ParsedRow {
  studentId: number;
  email: string;
  fullName: string;
  program: string;
  section: string;
}

const SAMPLE_CSV =
  "studentId,email,fullName,program,section\n3240001,jane@ctu.edu.ph,Jane Doe,BSIT,2-B";

// ---- Upload configuration ----
const ALLOWED_EXTENSIONS = [".docx", ".xls", ".xlsx", ".pdf", ".csv"] as const;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const PAGE_SIZE = 50;

// Section options are NOT predefined — they are derived dynamically from
// the loaded student data (see `availableSections` below). This handles
// CTU's varying section values that differ from the standard A-D pattern.

// ---- Validate a file purely on the client (reject before any network) ----
function validateClientFile(file: File): string | null {
  const dotIdx = file.name.lastIndexOf(".");
  const ext = dotIdx >= 0 ? file.name.slice(dotIdx).toLowerCase() : "";
  if (!ALLOWED_EXTENSIONS.includes(ext as (typeof ALLOWED_EXTENSIONS)[number])) {
    return `Unsupported file type "${ext || "(none)"}". Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`;
  }
  if (file.size > MAX_FILE_SIZE) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return `File is too large (${mb} MB). Maximum allowed is 10 MB.`;
  }
  if (file.size === 0) {
    return "The selected file is empty.";
  }
  return null;
}

// ---- Upload a file with XHR so we can report progress ----
function uploadFileWithProgress(
  file: File,
  onProgress: (pct: number) => void,
): Promise<{
  ok: boolean;
  status: number;
  data?: {
    students?: Array<{
      studentId: number;
      email: string;
      fullName: string;
      program: string;
      section: string;
    }>;
    errors?: string[];
    skipped?: number;
    totalRows?: number;
  };
  error?: string;
}> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/whitelist/import-file");
    xhr.withCredentials = true;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
      }
    };

    xhr.onload = () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      const ok = xhr.status >= 200 && xhr.status < 300;
      const data = parsed as
        | {
            students?: Array<{
              studentId: number;
              email: string;
              fullName: string;
              program: string;
              section: string;
            }>;
            errors?: string[];
            skipped?: number;
            totalRows?: number;
            error?: string;
          }
        | null;
      resolve({
        ok,
        status: xhr.status,
        data: ok ? data ?? undefined : undefined,
        error: ok ? undefined : data?.error || "Could not parse the file.",
      });
    };

    xhr.onerror = () =>
      resolve({
        ok: false,
        status: 0,
        error: "Network error — please check your connection and try again.",
      });

    xhr.ontimeout = () =>
      resolve({
        ok: false,
        status: 0,
        error: "Upload timed out. Please try a smaller file or check your connection.",
      });

    const formData = new FormData();
    formData.append("file", file);
    xhr.send(formData);
  });
}

export function WhitelistView() {
  // ---- Search state with 300ms debounce ----
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  // ---- Filter / sort / pagination state ----
  const [program, setProgram] = useState("");
  const [section, setSection] = useState("");
  const [sort, setSort] = useState<WhitelistSort>("program");
  const [page, setPage] = useState(1);

  // ---- Parsed-rows preview state ----
  const [parsed, setParsed] = useState<ParsedRow[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [pasted, setPasted] = useState("");
  const [fileParsing, setFileParsing] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [activeFilename, setActiveFilename] = useState<string>("");
  const [deleteTarget, setDeleteTarget] = useState<AuthorizedStudent | null>(
    null,
  );
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: currentUser } = useMe();
  const isAdmin = currentUser?.role === "ADMIN";

  const { data, isLoading, isFetching } = useWhitelist({
    q: q || undefined,
    program: program || undefined,
    section: section || undefined,
    sort,
    page,
    pageSize: PAGE_SIZE,
  });
  const importMut = useImportWhitelist();
  const deleteMut = useDeleteWhitelist();

  const students = data?.students ?? [];
  const pagination = data?.pagination;

  // ---- Derive available sections from the loaded student data ----
  // Sections are NOT predefined — they come from whatever sections
  // students actually have in the database. This handles CTU's varying
  // section values (e.g. "1-A", "2-B", "3-IT", "4-CT", etc.).
  const availableSections = useMemo(() => {
    const set = new Set<string>();
    for (const s of students) {
      if (s.section && s.section.trim()) {
        set.add(s.section.trim());
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [students]);

  // ---- Handle file upload via server-side parsing with progress ----
  async function handleFileUpload(file: File) {
    // 1. Strict client-side validation — reject before any network call.
    const err = validateClientFile(file);
    if (err) {
      toast({
        title: "Cannot upload this file",
        description: err,
        variant: "destructive",
      });
      return;
    }

    setFileParsing(true);
    setUploadPct(0);
    setActiveFilename(file.name);
    try {
      const res = await uploadFileWithProgress(file, setUploadPct);
      // Mark upload portion complete (server is now done parsing too).
      setUploadPct(100);

      if (!res.ok) {
        toast({
          title: "File processing failed",
          description: res.error || "Could not parse the file.",
          variant: "destructive",
        });
        return;
      }

      const d = res.data;
      const rows: ParsedRow[] = (d?.students || []).map((s) => ({
        studentId: s.studentId,
        email: s.email,
        fullName: s.fullName,
        program: s.program || "",
        section: s.section || "",
      }));

      setParsed(rows);
      setParseErrors(d?.errors || []);

      if (rows.length === 0 && (d?.errors || []).length > 0) {
        toast({
          title: "No valid students found",
          description: "Check the errors below and fix your file.",
          variant: "destructive",
        });
      } else if (rows.length > 0) {
        toast({
          title: `Found ${rows.length} student${rows.length === 1 ? "" : "s"}`,
          description: d?.errors?.length
            ? `${d.errors.length} row${d.errors.length === 1 ? "" : "s"} had problems`
            : `${d?.skipped || 0} skipped`,
        });
      } else {
        toast({
          title: "No students found",
          description: "The file didn't contain any parseable rows.",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Could not upload file",
        description: "Please check your connection and try again.",
        variant: "destructive",
      });
    } finally {
      setFileParsing(false);
      // Clear progress after a moment so the bar fades naturally.
      setTimeout(() => {
        setUploadPct(0);
        setActiveFilename("");
      }, 600);
    }
  }

  function handleParsePasted() {
    if (!pasted.trim()) return;
    const detected = Papa.parse<Record<string, string>>(pasted, {
      header: true,
      skipEmptyLines: true,
    });
    const { valid, errors } = normalizeRows(detected.data);
    setParsed(valid);
    setParseErrors(errors);
    if (valid.length === 0 && errors.length > 0) {
      toast({
        title: "No valid rows found",
        description: "Please fix the issues below and try again.",
        variant: "destructive",
      });
    } else if (valid.length > 0) {
      toast({
        title: `Found ${valid.length} student${valid.length === 1 ? "" : "s"}`,
        description: errors.length
          ? `${errors.length} row${errors.length === 1 ? "" : "s"} had problems`
          : undefined,
      });
    }
  }

  function commit() {
    if (parsed.length === 0) return;
    importMut.mutate(parsed, {
      onSuccess: (r) => {
        toast({
          title: `Added ${r.inserted} student${r.inserted === 1 ? "" : "s"}`,
          description: r.skipped
            ? `${r.skipped} were already on the list`
            : undefined,
        });
        setParsed([]);
        setParseErrors([]);
        setPasted("");
      },
      onError: (e) =>
        toast({
          title: "Could not add students",
          description: e.message,
          variant: "destructive",
        }),
    });
  }

  function removeRow(idx: number) {
    setParsed((p) => p.filter((_, i) => i !== idx));
  }

  function clearParsed() {
    setParsed([]);
    setParseErrors([]);
    setPasted("");
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteMut.mutateAsync(deleteTarget.studentId);
      toast({
        title: "Student removed",
        description: `${deleteTarget.fullName} is no longer on the approved list.`,
      });
    } catch (e) {
      toast({
        title: "Could not remove student",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  }

  return (
    <div className="space-y-6">
      {/* ============================================================
          Upload / paste card
         ============================================================ */}
      <Card>
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-primary" />
            Add approved students
          </CardTitle>
          <CardDescription className="flex items-center gap-1.5">
            Upload a file or paste rows — headers are auto-detected.
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Columns: studentId, email, fullName, program, section.
                Student ID must be 7 digits (e.g. 3240001).
                Program must be one of: BSIT, BSMx, BIT-CT, BIT-DT, BIT-ET, BIT-ELT.
              </TooltipContent>
            </Tooltip>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 p-4 sm:p-6 sm:pt-0">
          <div className="grid gap-4 md:grid-cols-2">
            {/* ---- File upload zone ---- */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="csv-file">Upload file</Label>
                <button
                  type="button"
                  onClick={() => window.open("/api/whitelist/template", "_blank")}
                  className="text-xs text-primary hover:underline flex items-center gap-1 min-h-[1.5rem]"
                >
                  <Download className="h-3 w-3" />
                  <span className="hidden sm:inline">Download template</span>
                  <span className="sm:hidden">Template</span>
                </button>
              </div>
              <div
                onClick={() => !fileParsing && fileRef.current?.click()}
                className="border-2 border-dashed border-border rounded-lg p-4 sm:p-6 text-center cursor-pointer hover:border-primary/50 hover:bg-accent/30 transition-colors"
              >
                <Upload className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
                <p className="text-sm font-medium">
                  {fileParsing ? "Uploading…" : "Click to choose a file"}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {ALLOWED_EXTENSIONS.join(", ")}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Max size: 10 MB
                </p>
                <input
                  ref={fileRef}
                  id="csv-file"
                  type="file"
                  accept={ALLOWED_EXTENSIONS.join(",")}
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) await handleFileUpload(f);
                    e.target.value = "";
                  }}
                />
              </div>

              {/* Upload progress bar */}
              {fileParsing && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                    <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                    <span className="truncate">
                      {activeFilename || "Parsing file"}… {uploadPct}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <motion.div
                      className="h-full bg-primary rounded-full"
                      initial={{ width: 0 }}
                      animate={{ width: `${uploadPct}%` }}
                      transition={{ duration: 0.2, ease: "easeOut" }}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {uploadPct < 100
                      ? "Uploading to server…"
                      : "Server is parsing your file…"}
                  </p>
                </div>
              )}

              {/* Allowed file types summary — always visible */}
              {!fileParsing && (
                <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                  <FileText className="h-3 w-3 mt-0.5 shrink-0" />
                  <span>
                    Accepted: Excel (.xlsx, .xls), Word (.docx), PDF (.pdf), CSV (.csv). Max 10 MB.
                  </span>
                </div>
              )}
            </div>

            {/* ---- Paste CSV zone ---- */}
            <div className="space-y-2">
              <Label htmlFor="pasted">Or paste CSV / TSV text</Label>
              <Textarea
                id="pasted"
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder={SAMPLE_CSV}
                className="h-32 font-mono text-xs ng-scroll"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleParsePasted}
                disabled={!pasted.trim()}
                className="h-9"
              >
                <ClipboardPaste className="h-4 w-4" />
                Read pasted text
              </Button>
            </div>
          </div>

          {/* ---- Parse errors ---- */}
          {parseErrors.length > 0 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-destructive flex items-center gap-1.5">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>
                    {parseErrors.length} problem{parseErrors.length === 1 ? "" : "s"} found
                  </span>
                </p>
                <button
                  type="button"
                  onClick={() => setParseErrors([])}
                  className="text-muted-foreground hover:text-foreground min-w-[1.5rem] min-h-[1.5rem] grid place-items-center"
                  aria-label="Dismiss errors"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <ul className="text-xs text-destructive space-y-0.5 max-h-24 overflow-y-auto ng-scroll">
                {parseErrors.map((err, i) => (
                  <li key={i} className="break-words">{err}</li>
                ))}
              </ul>
            </div>
          )}

          {/* ---- Parsed preview table ---- */}
          <AnimatePresence>
            {parsed.length > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="space-y-3"
              >
                <Separator />
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <Badge variant="secondary">
                    {parsed.length} student{parsed.length === 1 ? "" : "s"} ready to add
                  </Badge>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={clearParsed} className="h-9">
                      Clear all
                    </Button>
                    <Button
                      size="sm"
                      onClick={commit}
                      disabled={importMut.isPending}
                      className="h-9"
                    >
                      {importMut.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-4 w-4" />
                      )}
                      Add to approved list
                    </Button>
                  </div>
                </div>
                <div className="max-h-64 overflow-y-auto ng-scroll rounded-md border">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-8" />
                          <TableHead>Student ID</TableHead>
                          <TableHead>Full name</TableHead>
                          <TableHead>Email</TableHead>
                          <TableHead>Program</TableHead>
                          <TableHead>Section</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {parsed.map((r, i) => (
                          <TableRow key={`${r.studentId}-${i}`}>
                            <TableCell>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    type="button"
                                    onClick={() => removeRow(i)}
                                    className="text-muted-foreground hover:text-destructive min-w-[1.75rem] min-h-[1.75rem] grid place-items-center"
                                    aria-label={`Remove ${r.fullName}`}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent>Remove this row</TooltipContent>
                              </Tooltip>
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {r.studentId}
                            </TableCell>
                            <TableCell className="font-medium">{r.fullName}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {r.email}
                            </TableCell>
                            <TableCell>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge variant="outline" className="cursor-help">
                                    {r.program}
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {getProgramLabel(r.program) ?? r.program}
                                </TooltipContent>
                              </Tooltip>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">{r.section}</Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>

      {/* ============================================================
          Approved students list card
         ============================================================ */}
      <Card>
        <CardHeader className="p-4 sm:p-6">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-primary shrink-0" />
                  Approved students
                </CardTitle>
                <CardDescription>
                  {pagination?.total ?? 0} student{(pagination?.total ?? 0) === 1 ? "" : "s"} on the list
                  {isFetching && !isLoading && (
                    <span className="ml-1.5 text-muted-foreground/70">(updating…)</span>
                  )}
                </CardDescription>
              </div>
            </div>

            {/* Filter row — search on its own row, dropdowns below */}
            <div className="space-y-2">
              {/* Search row — full width on all devices */}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="Search name, email, or ID…"
                  value={qInput}
                  onChange={(e) => {
                    setQInput(e.target.value);
                    setPage(1);
                  }}
                  className="pl-8 h-9 w-full"
                />
                {qInput && (
                  <button
                    type="button"
                    onClick={() => {
                      setQInput("");
                      setQ("");
                      setPage(1);
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground min-w-[1.5rem] min-h-[1.5rem] grid place-items-center"
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Dropdown row — 3 equal columns on sm+, 2 columns on mobile */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <Select
                  value={program || "__all__"}
                  onValueChange={(val) => {
                    setProgram(val === "__all__" ? "" : val);
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="w-full h-9">
                    <SelectValue placeholder="All programs" />
                  </SelectTrigger>
                  <SelectContent className="max-w-[calc(100vw-1.5rem)]">
                    <SelectItem value="__all__">— All programs —</SelectItem>
                    {PROGRAMS.map((p) => (
                      <SelectItem key={p.code} value={p.code}>
                        {p.code} — {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={section || "__all__"}
                  onValueChange={(val) => {
                    setSection(val === "__all__" ? "" : val);
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="w-full h-9">
                    <SelectValue placeholder="All sections" />
                  </SelectTrigger>
                  <SelectContent className="max-w-[calc(100vw-1.5rem)]">
                    <SelectItem value="__all__">— All sections —</SelectItem>
                    {/* Dynamic sections derived from the loaded student data */}
                    {availableSections.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={sort}
                  onValueChange={(val) => {
                    setSort(val as WhitelistSort);
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="w-full h-9">
                    <SelectValue placeholder="Sort" />
                  </SelectTrigger>
                  <SelectContent className="max-w-[calc(100vw-1.5rem)]">
                    <SelectItem value="program">Sort: Program</SelectItem>
                    <SelectItem value="name">Sort: Name (A–Z)</SelectItem>
                    <SelectItem value="studentId">Sort: Student ID</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[28rem] overflow-y-auto ng-scroll">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>Student ID</TableHead>
                    <TableHead>Full name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Program</TableHead>
                    <TableHead>Section</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading && (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="text-center text-sm text-muted-foreground py-8"
                      >
                        Loading…
                      </TableCell>
                    </TableRow>
                  )}
                  {!isLoading && students.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="text-center text-sm text-muted-foreground py-8"
                      >
                        No students match your search.
                      </TableCell>
                    </TableRow>
                  )}
                  <AnimatePresence>
                    {students.map((s, i) => (
                      <motion.tr
                        key={s.studentId}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.2, delay: i * 0.02 }}
                        className="hover:bg-muted/50 border-b transition-colors"
                      >
                        <TableCell className="font-mono text-xs whitespace-nowrap">
                          {s.studentId}
                        </TableCell>
                        <TableCell className="font-medium">
                          <span className="block max-w-[12rem] sm:max-w-none truncate">
                            {s.fullName}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          <span className="block max-w-[10rem] sm:max-w-none truncate">
                            {s.email}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="outline" className="cursor-help">
                                {s.program}
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                              {getProgramLabel(s.program) ?? s.program}
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{s.section}</Badge>
                        </TableCell>
                        <TableCell>
                          {s.account ? (
                            <Badge
                              variant="secondary"
                              className={
                                "text-[10px] " +
                                (s.account.status === "ACTIVE"
                                  ? "border-emerald-500/40 text-emerald-600"
                                  : s.account.status === "SUSPENDED"
                                    ? "border-red-500/40 text-red-600"
                                    : "border-amber-500/40 text-amber-600")
                              }
                            >
                              {s.account.status === "ACTIVE"
                                ? "Active"
                                : s.account.status === "SUSPENDED"
                                  ? "Suspended"
                                  : "Pending"}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="border-muted text-muted-foreground text-[10px]">
                              <Clock className="h-2.5 w-2.5 mr-1" />
                              Pending registration
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {isAdmin ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-9 w-9 text-muted-foreground hover:text-destructive"
                                  onClick={() => setDeleteTarget(s)}
                                  aria-label={`Remove ${s.fullName}`}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                Remove from approved list
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className="text-[11px] text-muted-foreground/50">
                              —
                            </span>
                          )}
                        </TableCell>
                      </motion.tr>
                    ))}
                  </AnimatePresence>
                </TableBody>
              </Table>
            </div>
          </div>

          {/* ---- Pagination footer ---- */}
          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-t flex-wrap">
              <p className="text-xs text-muted-foreground">
                Page <span className="font-medium text-foreground">{pagination.page}</span> of{" "}
                <span className="font-medium text-foreground">{pagination.totalPages}</span>
                <span className="hidden sm:inline">
                  {" "}· {pagination.total} total
                </span>
              </p>
              <div className="flex gap-1 items-center">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 px-3"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                  <span className="hidden sm:inline ml-1">Prev</span>
                </Button>
                <span className="text-xs text-muted-foreground px-2 tabular-nums">
                  {pagination.page} / {pagination.totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 px-3"
                  disabled={page >= pagination.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  aria-label="Next page"
                >
                  <span className="hidden sm:inline mr-1">Next</span>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        destructive
        title="Remove this student?"
        description={`This will remove ${deleteTarget?.fullName ?? ""} (ID ${deleteTarget?.studentId ?? ""}) from the approved student list. Any existing account or attendance records will remain.`}
        confirmLabel="Remove from list"
        cancelLabel="Keep student"
        confirmText="REMOVE"
        step2Warning="The student will need to be re-imported to appear on the list again."
        onConfirm={handleDelete}
      />
    </div>
  );
}

/**
 * Normalize raw CSV rows into typed ParsedRow objects.
 * Returns the list of valid rows plus a list of human-readable error
 * messages for any rows that couldn't be parsed.
 *
 * The student ID column accepts the headers: studentId, student_id, id, studentid.
 * It must be a 7-digit number (e.g. 3240001) and is parsed as a number.
 */
function normalizeRows(
  rows: Record<string, string>[],
): { valid: ParsedRow[]; errors: string[] } {
  const valid: ParsedRow[] = [];
  const errors: string[] = [];

  rows.forEach((r, idx) => {
    const get = (keys: string[]) => {
      for (const k of keys) {
        const found = Object.keys(r).find(
          (rk) => rk.toLowerCase().trim() === k.toLowerCase(),
        );
        if (found) return r[found]?.trim() ?? "";
      }
      return "";
    };

    const idStr = get(["studentId", "student_id", "id", "studentid"]);
    const email = get(["email", "mail"]);
    const fullName =
      get(["fullName", "full_name", "name", "student_name"]) ||
      [
        get(["first_name", "firstName"]),
        get(["last_name", "lastName"]),
      ]
        .filter(Boolean)
        .join(" ");
    const program = get(["program", "department", "dept"]);
    const section = get(["section", "block", "sec"]);

    // Skip fully empty rows silently.
    if (!idStr && !email && !fullName && !program && !section) {
      return;
    }

    const rowLabel = `Row ${idx + 2}`; // +2 = header row + 1-based index

    if (!/^\d{7}$/.test(idStr)) {
      errors.push(
        `${rowLabel}: "${idStr || "(empty)"}" is not a valid 7-digit student ID.`,
      );
      return;
    }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      errors.push(`${rowLabel}: "${email || "(empty)"}" is not a valid email.`);
      return;
    }
    if (!fullName) {
      errors.push(`${rowLabel}: Missing full name.`);
      return;
    }
    if (!program) {
      errors.push(`${rowLabel}: Missing program.`);
      return;
    }
    if (!section) {
      errors.push(`${rowLabel}: Missing section.`);
      return;
    }

    valid.push({
      studentId: Number(idStr),
      email,
      fullName,
      program,
      section,
    });
  });

  return { valid, errors };
}
