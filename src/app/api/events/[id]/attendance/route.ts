import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, notFound, requireAuth, badRequest } from "@/lib/api";
import { hasMinimumRole } from "@/lib/rbac";
import { paginationSchema } from "@/lib/validation";
import { isEventVisibleToStudent } from "@/lib/event-visibility";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/events/[id]/attendance
// --------------------------------------------------------------------
// Authorization (v8 - mirrors GET /api/events visibility):
//  - ADMIN: can view attendance for ANY event.
//  - ORGANIZER: can view attendance for events they can SEE per the v8
//    rule (open-to-all, program-wide in their program, or exact program+
//    section match), OR events they own. The previous isProgramMatch
//    let a BSIT organizer read another section's (e.g. BSIT/2-B)
//    attendance roster - an info leak. v8 closes it.
//
// Pagination: ?page=1&pageSize=100 (max 200). Returns total count for the
// full roster so the client can show "X of Y present".
export async function GET(req: NextRequest, { params }: Ctx) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;
  const { id } = await params;
  const eventId = Number(id);

  const event = await db.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      title: true,
      targetProgram: true,
      targetSection: true,
      scheduledAt: true,
      ownerId: true,
      status: true,
      enableTimeOut: true,
    },
  });
  if (!event) return notFound("Event not found");

  // ---- Authorization check (v8 - mirrors GET /api/events visibility) ----
  if (!hasMinimumRole(account.role, "ADMIN")) {
    const isOwner = event.ownerId === account.id;
    const visible = isEventVisibleToStudent({
      targetProgram: event.targetProgram,
      targetSection: event.targetSection,
      studentProgram: account.program,
      studentSection: account.section,
    });
    if (!isOwner && !visible) {
      return forbidden("You can only view attendance for your own events");
    }
  }

  // ---- Pagination (bounded result set) ----
  const sp = req.nextUrl.searchParams;
  const parsed = paginationSchema.safeParse({
    page: sp.get("page") ?? 1,
    pageSize: sp.get("pageSize") ?? 100,
  });
  if (!parsed.success) return badRequest("Invalid pagination parameters");
  const { page, pageSize } = parsed.data;
  const skip = (page - 1) * pageSize;

  const [attendances, totalCount, eligibleCount] = await Promise.all([
    db.eventAttendance.findMany({
      where: { eventId },
      orderBy: { scannedAt: "asc" },
      skip,
      take: pageSize,
      include: {
        account: {
          select: {
            id: true,
            fullName: true,
            studentId: true,
            program: true,
            section: true,
          },
        },
      },
    }),
    db.eventAttendance.count({ where: { eventId } }),
    db.authorizedStudent.count({
      where: {
        program: event.targetProgram ?? undefined,
        ...(event.targetSection ? { section: event.targetSection } : {}),
      },
    }),
  ]);

  return NextResponse.json(
    {
      event,
      presentCount: totalCount,
      eligibleCount,
      attendances,
      pagination: {
        page,
        pageSize,
        total: totalCount,
        totalPages: Math.ceil(totalCount / pageSize),
      },
    },
    { headers: { "Cache-Control": "private, no-cache" } },
  );
}
