import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, notFound, requireAuth } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/events/[id]/attendance (owner or ADMIN)
export async function GET(_req: NextRequest, { params }: Ctx) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;
  const { id } = await params;
  const eventId = Number(id);

  const event = await db.event.findUnique({
    where: { id: eventId },
    select: {
      id: true, title: true, targetProgram: true, targetSection: true,
      scheduledAt: true, ownerId: true, status: true,
    },
  });
  if (!event) return notFound("Event not found");

  if (account.role !== "ADMIN" && event.ownerId !== account.id) {
    return forbidden("You can only view attendance for your own events");
  }

  const [attendances, eligibleCount] = await Promise.all([
    db.eventAttendance.findMany({
      where: { eventId },
      orderBy: { scannedAt: "asc" },
      include: {
        account: {
          select: { id: true, fullName: true, studentId: true, program: true, section: true },
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

  return NextResponse.json({ event, presentCount: attendances.length, eligibleCount, attendances });
}
