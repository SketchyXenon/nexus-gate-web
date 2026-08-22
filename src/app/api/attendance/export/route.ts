// Allow up to 15s for large exports.
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, notFound, requireAuth } from "@/lib/api";
import { hasMinimumRole } from "@/lib/rbac";

// GET /api/attendance/export?eventId=123
// Returns a CSV file of attendance records for a specific event.
//
// SORTING (v2): records are sorted by Program, Year, Section, then Student
// ID, so the exported roster groups students by their course/section block -
// intuitive for staff transferring attendance between systems.
//
// SCOPE (POLP):
//  - ADMIN: can export ANY event and sees ALL records.
//  - ORGANIZER: can export an event only if it is within their PROGRAM scope:
//      * they own the event, OR
//      * the event's targetProgram matches their own program, OR
//      * the event is department-wide (open to all, so their program's
//        students are present).
//    The exported rows are further filtered to students whose program matches
//    the organizer's own program (defense in depth) - even on a departmental
//    event the organizer only ever receives their own program's slice.
//
// COLUMNS: Program, Year, Section, Student ID, Full Name, Check-in Time,
// Time-out Time, Method. Times are rendered in Asia/Manila (PHT) for
// readability; a UTF-8 BOM is prefixed so Excel opens accented names
// correctly. The file is pure CSV (no PDF bloat) - lightweight and portable.
export async function GET(req: NextRequest) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;

  const eventId = Number(req.nextUrl.searchParams.get("eventId"));
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return NextResponse.json(
      { error: "Valid eventId is required.", code: "BAD_REQUEST" },
      { status: 400 },
    );
  }

  const event = await db.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      title: true,
      scheduledAt: true,
      ownerId: true,
      targetProgram: true,
      targetSection: true,
      scope: true,
    },
  });
  if (!event) return notFound("Event not found");

  const isAdmin = hasMinimumRole(account.role, "ADMIN");

  // ---- Authorization: is this event within the caller's scope? ----
  if (!isAdmin) {
    const isOwner = event.ownerId === account.id;
    const ownProgram = account.program;
    if (!ownProgram) {
      return forbidden(
        "Your account has no program assigned. Ask an administrator to set your program before exporting attendance.",
      );
    }
    const inProgramScope =
      event.scope === "departmental" ||
      (event.targetProgram != null && event.targetProgram === ownProgram);
    if (!isOwner && !inProgramScope) {
      return forbidden(
        `You can only export attendance within your own program (${ownProgram}). This event is outside your program scope.`,
      );
    }
  }

  // ---- Fetch records ----
  // Organizers only receive their own program's rows (defense in depth).
  // Capped at 10000 - a single event realistically has at most a few
  // thousand students; the cap prevents OOM on pathological inputs.
  const orgProgramFilter =
    !isAdmin && account.program
      ? { account: { program: account.program } }
      : {};

  const records = await db.eventAttendance.findMany({
    where: { eventId, ...orgProgramFilter },
    orderBy: [
      { account: { program: "asc" } },
      { account: { year: "asc" } },
      { account: { section: "asc" } },
      { account: { studentId: "asc" } },
    ],
    take: 10_000,
    select: {
      scannedAt: true,
      timeOutAt: true,
      source: true,
      account: {
        select: {
          fullName: true,
          studentId: true,
          program: true,
          section: true,
          year: true,
        },
      },
    },
  });

  // ---- CSV helpers ----
  // RFC 4180 quoting: wrap in quotes if the field contains comma, quote,
  // newline, or carriage return; double any embedded quotes.
  const escapeCsv = (val: string | number | null | undefined): string => {
    if (val === null || val === undefined) return "";
    const s = String(val);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  // Render timestamps in Asia/Manila (PHT, UTC+8) so the exported file reads
  // naturally for the institution's staff. Format: YYYY-MM-DD HH:MM AM/PM.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  const formatDateTime = (d: Date | null): string => {
    if (!d) return "";
    const parts = Object.fromEntries(
      fmt.formatToParts(d).map((p) => [p.type, p.value]),
    );
    const period = parts.dayPeriod ?? "";
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${period ? ` ${period}` : ""}`;
  };

  const header = [
    "Program",
    "Year",
    "Section",
    "Student ID",
    "Full Name",
    "Check-in Time",
    "Time-out Time",
    "Method",
  ].join(",");

  const rows = records.map((r) =>
    [
      escapeCsv(r.account.program),
      escapeCsv(r.account.year),
      escapeCsv(r.account.section),
      escapeCsv(r.account.studentId),
      escapeCsv(r.account.fullName),
      escapeCsv(formatDateTime(r.scannedAt)),
      escapeCsv(formatDateTime(r.timeOutAt)),
      escapeCsv(r.source === "override" ? "Manual" : "QR Scan"),
    ].join(","),
  );

  // UTF-8 BOM so Excel reads the encoding correctly (accented names etc.).
  const csv = "\uFEFF" + [header, ...rows].join("\r\n");

  const safeTitle = event.title.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 50);
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `attendance_${safeTitle}_${dateStr}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-cache",
    },
  });
}
