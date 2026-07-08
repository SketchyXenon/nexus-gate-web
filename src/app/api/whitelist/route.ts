import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  importWhitelistSchema,
  whitelistPaginationSchema,
} from "@/lib/validation";
import { badRequest, parseBody, requireAuth } from "@/lib/api";
import { audit } from "@/lib/audit";

// Allow up to 30s for large imports (up to 5000 students).
// Vercel default is 10s which can timeout on the Hobby plan.
export const maxDuration = 30;

// ====================================================================
// GET /api/whitelist (ORGANIZER+)
// --------------------------------------------------------------------
// Returns a merged view of:
//   1. Student accounts (role=USER) — registered students
//   2. Authorized students with no account — pending imports
//
// Each student record includes:
//   - status: "ACTIVE" | "PENDING" (PENDING = imported but not registered)
//   - activated: true (registered) | false (imported, pending)
// ====================================================================
export async function GET(req: NextRequest) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;

  const { searchParams } = new URL(req.url);
  const parsed = whitelistPaginationSchema.safeParse({
    page: searchParams.get("page") ?? 1,
    pageSize: searchParams.get("pageSize") ?? 50,
  });
  if (!parsed.success) return badRequest("Invalid pagination parameters");
  const { page, pageSize } = parsed.data;
  const program = searchParams.get("program") || undefined;
  const section = searchParams.get("section") || undefined;
  const q = searchParams.get("q") || undefined;
  const statusFilter = searchParams.get("status") || undefined; // "registered" | "pending" | "all"
  // Sort: "name" | "studentId" | "program" (default "program")
  const sortRaw = (searchParams.get("sort") || "program").toLowerCase();
  const sort =
    sortRaw === "name" || sortRaw === "studentid" || sortRaw === "program"
      ? sortRaw
      : "program";

  // ---- Build query for registered students (accounts) ----
  const accountWhere: Record<string, unknown> = { role: "USER" };
  if (program) accountWhere.program = program;
  if (section) accountWhere.section = section;
  if (q) {
    const asNumber = Number.parseInt(q, 10);
    const orClauses: Record<string, unknown>[] = [
      { fullName: { contains: q } },
      { email: { contains: q } },
    ];
    if (Number.isSafeInteger(asNumber) && /^[0-9]+$/.test(q)) {
      orClauses.push({ studentId: asNumber });
    }
    accountWhere.OR = orClauses;
  }

  // ---- Build query for pending students (authorized_students with no account) ----
  const authWhere: Record<string, unknown> = {};
  if (program) authWhere.program = program;
  if (section) authWhere.section = section;
  if (q) {
    const asNumber = Number.parseInt(q, 10);
    const orClauses: Record<string, unknown>[] = [
      { fullName: { contains: q } },
      { email: { contains: q } },
    ];
    if (Number.isSafeInteger(asNumber) && /^[0-9]+$/.test(q)) {
      orClauses.push({ studentId: asNumber });
    }
    authWhere.OR = orClauses;
  }

  // ---- Fetch both lists ----
  const [registeredAccounts, pendingStudents] = await Promise.all([
    statusFilter === "pending"
      ? []
      : db.account.findMany({
          where: accountWhere,
          orderBy: [
            { program: "asc" },
            { section: "asc" },
            { fullName: "asc" },
          ],
          select: {
            id: true,
            studentId: true,
            email: true,
            fullName: true,
            program: true,
            section: true,
            status: true,
            year: true,
            createdAt: true,
            lastLoginAt: true,
          },
        }),
    statusFilter === "registered"
      ? []
      : db.authorizedStudent.findMany({
          where: authWhere,
          orderBy: [
            { program: "asc" },
            { section: "asc" },
            { fullName: "asc" },
          ],
        }),
  ]);

  // ---- Get registered studentIds for filtering pending ----
  const registeredIds = new Set(registeredAccounts.map((a) => a.studentId));

  // ---- Filter pending: only show those WITHOUT an account ----
  const trulyPending = pendingStudents.filter(
    (s) => !registeredIds.has(s.studentId),
  );

  // ---- Merge into a unified list ----
  const merged = [
    ...registeredAccounts.map((a) => ({
      ...a,
      activated: true,
      registrationStatus: "registered" as const,
      account: { id: a.id, status: a.status },
    })),
    ...trulyPending.map((s) => ({
      id: null,
      studentId: s.studentId,
      email: s.email,
      fullName: s.fullName,
      program: s.program,
      section: s.section,
      status: "PENDING" as const,
      year: null,
      createdAt: null,
      lastLoginAt: null,
      activated: s.activated,
      registrationStatus: "pending" as const,
      account: null,
    })),
  ];

  // ---- Sort by chosen column ----
  merged.sort((a, b) => {
    if (sort === "studentid") {
      return (a.studentId ?? 0) - (b.studentId ?? 0);
    }
    if (sort === "name") {
      return (a.fullName || "").localeCompare(b.fullName || "");
    }
    // default: program → section → name
    if (a.program !== b.program)
      return (a.program || "").localeCompare(b.program || "");
    if (a.section !== b.section)
      return (a.section || "").localeCompare(b.section || "");
    return a.fullName.localeCompare(b.fullName);
  });

  // ---- Paginate ----
  const total = merged.length;
  const paginated = merged.slice(
    (page - 1) * pageSize,
    (page - 1) * pageSize + pageSize,
  );

  return NextResponse.json({
    students: paginated,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  });
}

// ====================================================================
// POST /api/whitelist (ORGANIZER+)
// --------------------------------------------------------------------
// Bulk import students into authorized_students table ONLY.
// Does NOT create accounts — students self-register later.
// Imported students are flagged as activated=false (pending).
// When a student registers, the register route sets activated=true.
// ====================================================================
export async function POST(req: NextRequest) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;

  const body = await parseBody(req);
  const parsed = importWhitelistSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  }

  let inserted = 0;
  let skipped = 0;

  // Batch insert: use createMany with skipDuplicates for new records,
  // then update existing ones in a single bulk operation.
  // This prevents 5000 sequential DB calls (DoS risk on serverless).
  const students = parsed.data.students;

  // Step 1: Fetch existing studentIds to separate inserts from updates.
  const studentIds = students.map((s) => s.studentId);
  const existing = await db.authorizedStudent.findMany({
    where: { studentId: { in: studentIds } },
    select: { studentId: true },
  });
  const existingIds = new Set(existing.map((e) => e.studentId));

  const toCreate = students
    .filter((s) => !existingIds.has(s.studentId))
    .map((s) => ({
      studentId: s.studentId,
      email: s.email,
      fullName: s.fullName,
      program: s.program,
      section: s.section,
      activated: false,
    }));

  const toUpdate = students.filter((s) => existingIds.has(s.studentId));

  // Step 2: Batch create new records.
  if (toCreate.length > 0) {
    try {
      const result = await db.authorizedStudent.createMany({
        data: toCreate,
        skipDuplicates: true,
      });
      inserted += result.count;
    } catch {
      skipped += toCreate.length;
    }
  }

  // Step 3: Update existing records (still sequential, but only for
  // records that already exist — typically a small subset).
  for (const s of toUpdate) {
    try {
      await db.authorizedStudent.update({
        where: { studentId: s.studentId },
        data: {
          email: s.email,
          fullName: s.fullName,
          program: s.program,
          section: s.section,
        },
      });
      inserted++;
    } catch {
      skipped++;
    }
  }

  await audit({
    actorId: account.id,
    action: "whitelist.import",
    targetType: "Whitelist",
    metadata: { inserted, skipped, total: parsed.data.students.length },
    req,
  });

  return NextResponse.json({
    inserted,
    skipped,
    total: parsed.data.students.length,
  });
}
