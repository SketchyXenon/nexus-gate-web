import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, notFound, requireAuth } from "@/lib/api";
import { hasMinimumRole } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/events/[id]/attendance
// --------------------------------------------------------------------
// Authorization (v2):
//   - ADMIN: can view attendance for ANY event.
//   - ORGANIZER: can view attendance for events they can SEE:
//       1. Events they own, OR
//       2. Open-to-all events, OR
//       3. Events in their own program (any section — for QR delegation), OR
//       4. Events that exactly match their program + section.
//     This mirrors the visibility rules in GET /api/events so that
//     organizers who can see an event in their list can also view its
//     attendance (needed for the Overrides page).
export async function GET(_req: NextRequest, { params }: Ctx) {
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
    },
  });
  if (!event) return notFound("Event not found");

  // ---- Authorization check (mirrors GET /api/events visibility) ----
  if (!hasMinimumRole(account.role, "ADMIN")) {
    const isOwner = event.ownerId === account.id;
    const isOpenToAll = !event.targetProgram && !event.targetSection;
    const isProgramMatch =
      !!event.targetProgram && event.targetProgram === account.program;
    const isExactMatch =
      !!event.targetProgram &&
      !!event.targetSection &&
      event.targetProgram === account.program &&
      event.targetSection === account.section;

    if (!isOwner && !isOpenToAll && !isProgramMatch && !isExactMatch) {
      return forbidden("You can only view attendance for your own events");
    }
  }

  const [attendances, eligibleCount] = await Promise.all([
    db.eventAttendance.findMany({
      where: { eventId },
      orderBy: { scannedAt: "asc" },
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
      presentCount: attendances.length,
      eligibleCount,
      attendances,
    },
    { headers: { "Cache-Control": "private, no-cache" } },
  );
}
