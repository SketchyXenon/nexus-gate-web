import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  parseBody,
  requireAuth,
} from "@/lib/api";
import { overrideSchema } from "@/lib/validation";
import { audit } from "@/lib/audit";
import { notifyAttendance } from "@/lib/realtime";
import { getEventTimeWindows } from "@/lib/event-time";

// POST /api/attendance/override
export async function POST(req: NextRequest) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;

  const body = await parseBody(req);
  const parsed = overrideSchema.safeParse(body);
  if (!parsed.success)
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  const { eventId, studentId, reason } = parsed.data;

  const event = await db.event.findUnique({ where: { id: eventId } });
  if (!event) return notFound("Event not found");
  if (account.role !== "ADMIN" && event.ownerId !== account.id) {
    return forbidden("You can only add overrides for your own events");
  }

  // Check if the student is on the whitelist OR has an account.
  // The whitelist is the primary source, but students who registered
  // directly (without being whitelisted) should also be eligible.
  const student = await db.authorizedStudent.findUnique({
    where: { studentId },
  });
  let studentName: string;
  let studentProgram: string | null;
  let studentSection: string | null;

  if (student) {
    studentName = student.fullName;
    studentProgram = student.program;
    studentSection = student.section;
  } else {
    // Not on whitelist — check if they have an account.
    const studentAccount = await db.account.findUnique({
      where: { studentId },
    });
    if (!studentAccount) {
      return badRequest(
        "This student is not on the approved list and has no account.",
        "NOT_WHITELISTED",
      );
    }
    studentName = studentAccount.fullName;
    studentProgram = studentAccount.program;
    studentSection = studentAccount.section;
  }

  // Verify the student is eligible for this event (matches target program/section).
  if (event.targetProgram && studentProgram !== event.targetProgram) {
    return forbidden("This student is not eligible for this event");
  }
  if (event.targetSection && studentSection !== event.targetSection) {
    return forbidden("This student is not eligible for this event");
  }

  // ---- Anti-cheating: same time window as scanning ----
  // Uses the shared helper (plural — includes time-out window).
  // Organizers can add overrides while EITHER the check-in window OR
  // the time-out window is live. This allows manual entries during
  // the full event lifecycle.
  const windows = getEventTimeWindows(event);
  const checkInLive = windows.checkIn.isLive;
  const timeOutLive = windows.timeOut?.isLive ?? false;

  if (!checkInLive && !timeOutLive) {
    if (windows.checkIn.isUpcoming) {
      return forbidden("This event hasn't opened for check-in yet.");
    }
    return forbidden("This event's check-in window has closed.");
  }

  let studentAccount = await db.account.findUnique({ where: { studentId } });
  if (!studentAccount) {
    return badRequest(
      "This student has not created an account yet.",
      "NO_ACCOUNT",
    );
  }

  let result;
  try {
    result = await db.$transaction(async (tx) => {
      const override = await tx.attendanceOverride.create({
        data: { eventId, adminId: account.id, studentId, reason },
      });
      const attendance = await tx.eventAttendance.upsert({
        where: {
          eventId_accountId: { eventId, accountId: studentAccount!.id },
        },
        update: {},
        create: { eventId, accountId: studentAccount!.id, source: "override" },
      });
      return { override, attendance };
    });
  } catch (e) {
    // P2002 = unique constraint violation (duplicate override).
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Unique constraint")) {
      return conflict(
        "This student already has an override for this event.",
        "ALREADY_OVERRIDDEN",
      );
    }
    throw e;
  }

  notifyAttendance(eventId, {
    id: result.attendance.id,
    accountId: studentAccount.id,
    fullName: studentAccount.fullName,
    studentId: studentAccount.studentId,
    program: studentAccount.program,
    section: studentAccount.section,
    scannedAt: result.attendance.scannedAt.toISOString(),
    source: "override",
  }).catch(() => {});

  await audit({
    actorId: account.id,
    action: "attendance.override",
    targetType: "EventAttendance",
    targetId: result.attendance.id,
    metadata: { eventId, studentId, reason },
    req,
  });

  return NextResponse.json(result, { status: 201 });
}
