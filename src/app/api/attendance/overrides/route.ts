import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

// GET /api/attendance/overrides
// Query params:
//   page      — 1-indexed page number (default 1)
//   pageSize  — items per page (default 25, max 100)
//   eventId   — filter by a specific event id (optional)
//   q         — search by student name, student ID, or reason (optional)
//   from      — ISO date; only overrides createdAt >= from (optional)
//   to        — ISO date; only overrides createdAt <= to (optional)
//
// Returns overrides the caller is allowed to see:
//   - ADMIN: all overrides
//   - ORGANIZER: only overrides for events they own
//   - USER: forbidden (this is a staff-only view)
export async function GET(req: NextRequest) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(
      1,
      Number(url.searchParams.get("pageSize") ?? String(DEFAULT_PAGE_SIZE)) ||
        DEFAULT_PAGE_SIZE
    )
  );
  const eventIdParam = url.searchParams.get("eventId");
  const eventId = eventIdParam ? Number(eventIdParam) : undefined;
  const q = url.searchParams.get("q")?.trim() || undefined;
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const from = fromParam ? new Date(fromParam) : undefined;
  const to = toParam ? new Date(toParam) : undefined;

  // Build the where clause.
  // - Non-admins can only see overrides for events they own.
  // - eventId filter narrows to a single event (must still be owned).
  const where: { AND: Array<Record<string, unknown>> } = { AND: [] };

  if (account.role !== "ADMIN") {
    // Restrict to events owned by this organizer.
    where.AND.push({ event: { ownerId: account.id } });
  }

  if (eventId != null && !Number.isNaN(eventId)) {
    where.AND.push({ eventId });
  }

  if (from || to) {
    const created: Record<string, Date> = {};
    if (from) created.gte = from;
    if (to) created.lte = to;
    where.AND.push({ createdAt: created });
  }

  if (q) {
    // SQLite doesn't support case-insensitive LIKE on unicode by default, but
    // for ASCII names/IDs/emails it works. We use `contains` and also match
    // numeric studentId when the query parses as a number.
    const orClauses: Array<Record<string, unknown>> = [
      { reason: { contains: q } },
      { student: { fullName: { contains: q } } },
      { student: { email: { contains: q } } },
      { admin: { fullName: { contains: q } } },
    ];
    const asNum = Number(q);
    if (!Number.isNaN(asNum)) {
      orClauses.push({ studentId: asNum });
    }
    where.AND.push({ OR: orClauses });
  }

  const [overrides, total] = await Promise.all([
    db.attendanceOverride.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        event: {
          select: {
            id: true,
            title: true,
            scheduledAt: true,
            targetProgram: true,
            targetSection: true,
          },
        },
        student: {
          select: {
            studentId: true,
            fullName: true,
            program: true,
            section: true,
            email: true,
          },
        },
        admin: { select: { id: true, fullName: true, email: true } },
      },
    }),
    db.attendanceOverride.count({ where }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return NextResponse.json({
    overrides: overrides.map((o) => ({
      id: o.id,
      eventId: o.eventId,
      studentId: o.studentId,
      reason: o.reason,
      createdAt: o.createdAt.toISOString(),
      event: {
        id: o.event.id,
        title: o.event.title,
        scheduledAt: o.event.scheduledAt.toISOString(),
        targetProgram: o.event.targetProgram,
        targetSection: o.event.targetSection,
      },
      student: {
        studentId: o.student.studentId,
        fullName: o.student.fullName,
        program: o.student.program,
        section: o.student.section,
        email: o.student.email,
      },
      admin: o.admin
        ? { id: o.admin.id, fullName: o.admin.fullName, email: o.admin.email }
        : null,
    })),
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
    },
  });
}
