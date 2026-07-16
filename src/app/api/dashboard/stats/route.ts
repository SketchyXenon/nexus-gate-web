// Allow up to 10s for the aggregation queries.
export const maxDuration = 10;

import { NextRequest, NextResponse } from "next/server";
import { dbRead } from "@/lib/db";
import { requireAuth } from "@/lib/api";
import { hasMinimumRole } from "@/lib/rbac";

// GET /api/dashboard/stats
// Returns time-series + breakdown data for dashboard charts.
// Organizer sees only their own events; admin sees all.
//
// Uses SQL GROUP BY for aggregations instead of fetching raw rows into
// memory. This keeps the response time constant regardless of scan volume
// (previously fetched up to 50,000 rows and bucketed in JS).
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

  // Last 30 days boundary.
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  thirtyDaysAgo.setHours(0, 0, 0, 0);

  // For organizers, filter by their owned events. For admins, no filter.
  // The raw SQL uses a JOIN to event_attendance -> events for the organizer
  // scope, or a direct scan for admins.
  if (isAdmin) {
    return NextResponse.json(await buildAdminStats(thirtyDaysAgo), {
      headers: { "Cache-Control": "private, no-cache" },
    });
  }
  return NextResponse.json(
    await buildOrganizerStats(account.id, thirtyDaysAgo),
    {
      headers: { "Cache-Control": "private, no-cache" },
    },
  );
}

// Admin stats: no event-owner filter.
// Uses dbRead (read replica if configured) for the heavy aggregate queries.
async function buildAdminStats(thirtyDaysAgo: Date) {
  const [dayRows, hourRows, sourceRows, topEvents] = await Promise.all([
    // Scans per day (last 30 days) via SQL GROUP BY.
    dbRead.$queryRaw<Array<{ day: string; count: bigint }>>`
      SELECT DATE(scanned_at) AS day, COUNT(*) AS count
      FROM event_attendance
      WHERE scanned_at >= ${thirtyDaysAgo}
      GROUP BY DATE(scanned_at)
    `,
    // Scans per hour-of-day (last 30 days) via SQL EXTRACT.
    dbRead.$queryRaw<Array<{ hour: number; count: bigint }>>`
      SELECT EXTRACT(HOUR FROM scanned_at)::int AS hour, COUNT(*) AS count
      FROM event_attendance
      WHERE scanned_at >= ${thirtyDaysAgo}
      GROUP BY EXTRACT(HOUR FROM scanned_at)
    `,
    // Source breakdown.
    dbRead.eventAttendance.groupBy({
      by: ["source"],
      _count: true,
    }),
    // Top events by attendance count.
    dbRead.event.findMany({
      where: { status: "active" },
      select: {
        id: true,
        title: true,
        scheduledAt: true,
        _count: { select: { attendances: true } },
      },
      orderBy: { attendances: { _count: "desc" } },
      take: 10,
    }),
  ]);

  return formatStats(dayRows, hourRows, sourceRows, topEvents);
}

// Organizer stats: scoped to their owned events.
// Uses dbRead (read replica if configured) for the heavy aggregate queries.
async function buildOrganizerStats(ownerId: string, thirtyDaysAgo: Date) {
  const [dayRows, hourRows, sourceRows, topEvents] = await Promise.all([
    dbRead.$queryRaw<Array<{ day: string; count: bigint }>>`
      SELECT DATE(ea.scanned_at) AS day, COUNT(*) AS count
      FROM event_attendance ea
      JOIN events e ON e.id = ea.event_id
      WHERE ea.scanned_at >= ${thirtyDaysAgo} AND e.owner_id = ${ownerId}
      GROUP BY DATE(ea.scanned_at)
    `,
    dbRead.$queryRaw<Array<{ hour: number; count: bigint }>>`
      SELECT EXTRACT(HOUR FROM ea.scanned_at)::int AS hour, COUNT(*) AS count
      FROM event_attendance ea
      JOIN events e ON e.id = ea.event_id
      WHERE ea.scanned_at >= ${thirtyDaysAgo} AND e.owner_id = ${ownerId}
      GROUP BY EXTRACT(HOUR FROM ea.scanned_at)
    `,
    dbRead.eventAttendance.groupBy({
      by: ["source"],
      where: { event: { ownerId } },
      _count: true,
    }),
    dbRead.event.findMany({
      where: { status: "active", ownerId },
      select: {
        id: true,
        title: true,
        scheduledAt: true,
        _count: { select: { attendances: true } },
      },
      orderBy: { attendances: { _count: "desc" } },
      take: 10,
    }),
  ]);

  return formatStats(dayRows, hourRows, sourceRows, topEvents);
}

// Format the raw SQL results into the API response shape.
function formatStats(
  dayRows: Array<{ day: string; count: bigint }>,
  hourRows: Array<{ hour: number; count: bigint }>,
  sourceRows: Array<{ source: string; _count: number }>,
  topEvents: Array<{
    id: number;
    title: string;
    scheduledAt: Date;
    _count: { attendances: number };
  }>,
) {
  // Build scansByDay: fill all 30 days (0 for days with no scans).
  const dayMap = new Map<string, number>();
  for (let i = 0; i < 30; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    dayMap.set(d.toISOString().slice(0, 10), 0);
  }
  for (const row of dayRows) {
    const key = String(row.day).slice(0, 10);
    if (dayMap.has(key)) dayMap.set(key, Number(row.count));
  }
  const scansByDay = Array.from(dayMap.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, count]) => ({ date, count }));

  // Build scansByHour: 24 buckets.
  const hourBuckets = new Array(24).fill(0);
  for (const row of hourRows) {
    hourBuckets[row.hour] = Number(row.count);
  }
  const scansByHour = hourBuckets.map((count, hour) => ({ hour, count }));

  // Build scansBySource.
  const scansBySource: { qr: number; override: number } = {
    qr: 0,
    override: 0,
  };
  for (const s of sourceRows) {
    if (s.source === "qr") scansBySource.qr = s._count;
    else if (s.source === "override") scansBySource.override = s._count;
  }

  return {
    scansByDay,
    topEvents: topEvents.map((e) => ({
      id: e.id,
      title: e.title,
      scheduledAt: e.scheduledAt,
      presentCount: e._count.attendances,
    })),
    scansBySource,
    scansByHour,
  };
}
