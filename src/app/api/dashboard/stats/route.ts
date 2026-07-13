// Allow up to 10s for the aggregation queries.
export const maxDuration = 10;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api";
import { hasMinimumRole } from "@/lib/rbac";

// GET /api/dashboard/stats
// Returns time-series + breakdown data for dashboard charts.
// Organizer sees only their own events; admin sees all.
//
// Response:
//   scansByDay: [{ date: "YYYY-MM-DD", count: number }] — last 30 days
//   topEvents:  [{ id, title, scheduledAt, presentCount }] — top 10 by attendance
//   scansBySource: { qr: number, override: number }
//   scansByHour: [{ hour: 0-23, count: number }] — peak-hour distribution
export async function GET(_req: NextRequest) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;

  const isAdmin = hasMinimumRole(account.role, "ADMIN");
  const eventWhere = isAdmin ? {} : { ownerId: account.id };
  const attendanceWhere = isAdmin ? {} : { event: { ownerId: account.id } };

  // Last 30 days boundary.
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  thirtyDaysAgo.setHours(0, 0, 0, 0);

  // Run all queries in parallel. recentAttendance and hourCounts previously
  // did two overlapping findMany on the same 30-day window; merged into one
  // query (recentAttendance) and derived hourCounts from it below.
  const [recentAttendance, topEvents, sourceCounts] =
    await Promise.all([
      // Scans in the last 30 days (for both the time-series and hour charts).
      // Capped at 50000 to prevent OOM on very high-traffic organizers.
      db.eventAttendance.findMany({
        where: {
          ...attendanceWhere,
          scannedAt: { gte: thirtyDaysAgo },
        },
        select: { scannedAt: true, source: true },
        orderBy: { scannedAt: "asc" },
        take: 50_000,
      }),

      // Top events by attendance count.
      db.event.findMany({
        where: { ...eventWhere, status: "active" },
        select: {
          id: true,
          title: true,
          scheduledAt: true,
          _count: { select: { attendances: true } },
        },
        orderBy: { attendances: { _count: "desc" } },
        take: 10,
      }),

      // Source breakdown (qr vs override).
      db.eventAttendance.groupBy({
        by: ["source"],
        where: attendanceWhere,
        _count: true,
      }),
    ]);

  // Build scansByDay: bucket by YYYY-MM-DD.
  const dayMap = new Map<string, number>();
  for (let i = 0; i < 30; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    dayMap.set(d.toISOString().slice(0, 10), 0);
  }
  for (const a of recentAttendance) {
    const key = a.scannedAt.toISOString().slice(0, 10);
    if (dayMap.has(key)) dayMap.set(key, (dayMap.get(key) ?? 0) + 1);
  }
  const scansByDay = Array.from(dayMap.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, count]) => ({ date, count }));

  // Build scansByHour: 24 buckets.
  const hourBuckets = new Array(24).fill(0);
  // Derive hour-of-day distribution from recentAttendance (no separate query).
  for (const a of recentAttendance) {
    hourBuckets[a.scannedAt.getHours()]++;
  }
  const scansByHour = hourBuckets.map((count, hour) => ({ hour, count }));

  // Build scansBySource.
  const scansBySource: { qr: number; override: number } = { qr: 0, override: 0 };
  for (const s of sourceCounts) {
    if (s.source === "qr") scansBySource.qr = s._count;
    else if (s.source === "override") scansBySource.override = s._count;
  }

  const statsRes = NextResponse.json({
    scansByDay,
    topEvents: topEvents.map((e) => ({
      id: e.id,
      title: e.title,
      scheduledAt: e.scheduledAt,
      presentCount: e._count.attendances,
    })),
    scansBySource,
    scansByHour,
  });
  statsRes.headers.set(
    "Cache-Control",
    "private, no-cache",
  );
  return statsRes;
}
