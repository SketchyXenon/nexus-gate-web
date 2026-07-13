// Allow up to 10s for the aggregation query.
export const maxDuration = 10;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api";

// GET /api/profile/attendance
// Returns the calling student's own attendance history with optional filters.
// Only available to USER role (students).
//
// Query params:
//   ?from=YYYY-MM-DD  — include scans on or after this date
//   ?to=YYYY-MM-DD    — include scans on or before this date
//   ?scope=academic   — filter by event scope ("academic" | "departmental")
//
// Response:
//   records: [{ id, scannedAt, timeOutAt, source, event: { id, title, scheduledAt, scope, targetProgram, targetSection } }]
//   stats: { total, qrCount, overrideCount, withTimeout }
export async function GET(req: NextRequest) {
  const res = await requireAuth("USER", { exactRole: true });
  if ("error" in res) return res.error;
  const { account } = res;

  const sp = req.nextUrl.searchParams;
  const fromStr = sp.get("from");
  const toStr = sp.get("to");
  const scope = sp.get("scope");

  // Build the where clause.
  const where: Record<string, unknown> = { accountId: account.id };
  const eventWhere: Record<string, unknown> = {};
  if (scope) eventWhere.scope = scope;
  if (Object.keys(eventWhere).length > 0) where.event = eventWhere;

  // Date range on scannedAt.
  if (fromStr || toStr) {
    const scannedAt: Record<string, Date> = {};
    if (fromStr) {
      const d = new Date(fromStr + "T00:00:00");
      if (!isNaN(d.getTime())) scannedAt.gte = d;
    }
    if (toStr) {
      const d = new Date(toStr + "T23:59:59");
      if (!isNaN(d.getTime())) scannedAt.lte = d;
    }
    if (Object.keys(scannedAt).length > 0) where.scannedAt = scannedAt;
  }

  const records = await db.eventAttendance.findMany({
    where,
    orderBy: { scannedAt: "desc" },
    take: 200,
    select: {
      id: true,
      scannedAt: true,
      timeOutAt: true,
      source: true,
      event: {
        select: {
          id: true,
          title: true,
          scheduledAt: true,
          scope: true,
          targetProgram: true,
          targetSection: true,
        },
      },
    },
  });

  // Compute summary stats.
  const stats = {
    total: records.length,
    qrCount: records.filter((r) => r.source === "qr").length,
    overrideCount: records.filter((r) => r.source === "override").length,
    withTimeout: records.filter((r) => r.timeOutAt !== null).length,
  };

  const response = NextResponse.json({ records, stats });
  response.headers.set(
    "Cache-Control",
    "private, no-cache",
  );
  return response;
}
