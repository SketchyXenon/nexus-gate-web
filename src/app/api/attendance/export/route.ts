// Allow up to 15s for large exports.
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api";
import { hasMinimumRole } from "@/lib/rbac";

// GET /api/attendance/export?eventId=123
// Returns a CSV file of attendance records for a specific event.
// Organizer can only export their own events; admin can export any.
//
// CSV columns: Student ID, Full Name, Program, Section, Scanned At, Time Out At, Source
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

  // Fetch the event (with ownership check for organizers).
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
  if (!event) {
    return NextResponse.json(
      { error: "Event not found.", code: "NOT_FOUND" },
      { status: 404 },
    );
  }

  // Organizers can only export their own events.
  if (!hasMinimumRole(account.role, "ADMIN") && event.ownerId !== account.id) {
    return NextResponse.json(
      { error: "You can only export your own events.", code: "FORBIDDEN" },
      { status: 403 },
    );
  }

  // Fetch attendance records for this event (capped at 10000 to prevent OOM
  // on events with extremely high attendance; a single event realistically
  // has at most a few thousand students).
  const records = await db.eventAttendance.findMany({
    where: { eventId },
    orderBy: { scannedAt: "asc" },
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
        },
      },
    },
  });

  // Build CSV. Quote fields that may contain commas.
  const escapeCsv = (val: string | number | null | undefined): string => {
    if (val === null || val === undefined) return "";
    const s = String(val);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const formatDateTime = (d: Date | null): string =>
    d ? d.toISOString() : "";

  const header = [
    "Student ID",
    "Full Name",
    "Program",
    "Section",
    "Scanned At",
    "Time Out At",
    "Source",
  ].join(",");

  const rows = records.map((r) =>
    [
      escapeCsv(r.account.studentId),
      escapeCsv(r.account.fullName),
      escapeCsv(r.account.program),
      escapeCsv(r.account.section),
      escapeCsv(formatDateTime(r.scannedAt)),
      escapeCsv(formatDateTime(r.timeOutAt)),
      escapeCsv(r.source === "override" ? "Manual" : "QR Scan"),
    ].join(","),
  );

  const csv = [header, ...rows].join("\n");

  // Sanitize the event title for the filename.
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
