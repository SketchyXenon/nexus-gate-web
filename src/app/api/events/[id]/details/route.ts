import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, notFound, requireAuth } from "@/lib/api";
import { getEventTimeWindows } from "@/lib/event-time";
import { getProgramLabel } from "@/lib/programs";

type Ctx = { params: Promise<{ id: string }> };

// ====================================================================
// GET /api/events/[id]/details  (any authenticated user)
//
// Returns full event info for the details dialog. Differs from the
// organizer-only GET /api/events/[id] (which returns eventSecret) by:
//   - NEVER returning eventSecret
//   - returning the caller's own attendance record (for students)
//   - returning computed check-in / time-out window status
//   - returning a human-readable program label
//
// Access rules:
//   - ADMIN: any event
//   - ORGANIZER: own events (or any, since this is read-only details —
//     but we still scope to own events to match the rest of the app)
//   - USER: only events targeted at their program/section (so students
//     can't browse other classes' events)
// ====================================================================

export async function GET(_req: NextRequest, { params }: Ctx) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;
  const { id } = await params;
  const eventId = Number(id);

  const event = await db.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      title: true,
      description: true,
      scope: true,
      targetProgram: true,
      targetSection: true,
      scheduledAt: true,
      endsAt: true,
      enableTimeOut: true,
      status: true,
      ownerId: true,
      delegatable: true, delegationEnabled: true,
      checkInOpensAt: true,
      checkInClosesAt: true,
      timeOutOpensAt: true,
      timeOutClosesAt: true,
      _count: { select: { attendances: true } },
    },
  });
  if (!event) return notFound("Event not found");

  // ---- Access scoping ----
  // ORGANIZERs can view their own events. They may also view OTHER
  // organizers' events IF the STRICT delegation rules are met:
  //   1. Organizer has a non-empty organizationName tag
  //   2. Event's delegationEnabled is true
  //   3. Event owner also has a non-empty organizationName tag
  //   4. Both org tags match
  // ADMIN sees all events.
  if (account.role === "ORGANIZER" && event.ownerId !== account.id) {
    const organizerOrg = account.organizationName?.trim();
    if (!organizerOrg) {
      return forbidden("You have no organization tag set. An administrator must set your organization tag before you can view other organizers' events.");
    }
    if (!event.delegationEnabled) {
      return forbidden("You can only view your own events. QR delegation is not enabled for this event.");
    }
    const owner = await db.account.findUnique({
      where: { id: event.ownerId },
      select: { organizationName: true },
    });
    const ownerOrg = owner?.organizationName?.trim();
    if (!ownerOrg || ownerOrg !== organizerOrg) {
      return forbidden("You can only view events from the same organization with delegation enabled.");
    }
  }
  if (account.role === "USER") {
    // STRICT visibility (mirrors GET /api/events list scoping):
    //   - Open-to-all events (targetProgram AND targetSection both null) → allow
    //   - Exact program + section match → allow
    //   - Program-wide events (targetProgram set, targetSection null) are
    //     HIDDEN from students on the list, so they must also be rejected
    //     here. Otherwise a student could read details of any program-wide
    //     event by guessing the id.
    const isOpenToAll = !event.targetProgram && !event.targetSection;
    const isExactMatch =
      !!event.targetProgram &&
      !!event.targetSection &&
      event.targetProgram === account.program &&
      event.targetSection === account.section;
    if (!isOpenToAll && !isExactMatch) {
      return forbidden("This event isn't available to you");
    }
  }

  // ---- For students, also fetch their own attendance row ----
  let myAttendance: {
    id: number;
    scannedAt: string;
    timeOutAt: string | null;
    source: string;
  } | null = null;
  if (account.role === "USER") {
    const row = await db.eventAttendance.findUnique({
      where: {
        eventId_accountId: { eventId, accountId: account.id },
      },
      select: { id: true, scannedAt: true, timeOutAt: true, source: true },
    });
    if (row) {
      myAttendance = {
        id: row.id,
        scannedAt: row.scannedAt.toISOString(),
        timeOutAt: row.timeOutAt ? row.timeOutAt.toISOString() : null,
        source: row.source,
      };
    }
  }

  // ---- Compute window status (check-in + optional time-out) ----
  const windows = getEventTimeWindows({
    scheduledAt: event.scheduledAt,
    endsAt: event.endsAt,
    checkInOpensAt: event.checkInOpensAt,
    checkInClosesAt: event.checkInClosesAt,
    timeOutOpensAt: event.timeOutOpensAt,
    timeOutClosesAt: event.timeOutClosesAt,
    enableTimeOut: event.enableTimeOut,
    status: event.status,
  });

  // ---- Never leak the eventSecret on this endpoint ----
  return NextResponse.json({
    id: event.id,
    title: event.title,
    description: event.description,
    scope: event.scope,
    targetProgram: event.targetProgram,
    targetProgramLabel: event.targetProgram
      ? getProgramLabel(event.targetProgram)
      : null,
    targetSection: event.targetSection,
    scheduledAt: event.scheduledAt.toISOString(),
    endsAt: event.endsAt ? event.endsAt.toISOString() : null,
    enableTimeOut: event.enableTimeOut,
    status: event.status,
    attendanceCount: event._count.attendances,
    myAttendance,
    windows: {
      checkIn: {
        opensAt: windows.checkIn.opensAt.toISOString(),
        closesAt: windows.checkIn.closesAt.toISOString(),
        isLive: windows.checkIn.isLive,
        isUpcoming: windows.checkIn.isUpcoming,
        isEnded: windows.checkIn.isEnded,
      },
      timeOut: windows.timeOut
        ? {
            opensAt: windows.timeOut.opensAt.toISOString(),
            closesAt: windows.timeOut.closesAt.toISOString(),
            isLive: windows.timeOut.isLive,
          }
        : null,
    },
  });
}
