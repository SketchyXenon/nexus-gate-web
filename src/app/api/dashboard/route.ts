import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api";
import { getTimeStatus } from "@/lib/event-time";
import { studentNeedsProfile } from "@/lib/event-visibility";

// GET /api/dashboard
// Short cache to reduce DB load on repeated page loads (30s stale-while-revalidate).
export async function GET(_req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  if (account.role === "USER") {
    const hasProgramAndSection = !!account.program && !!account.section;
    const eligibleBase = hasProgramAndSection
      ? {
          status: "active" as const,
          OR: [
            { targetProgram: null, targetSection: null },
            { targetProgram: account.program, targetSection: account.section },
          ],
        }
      : {
          status: "active" as const,
          targetProgram: null,
          targetSection: null,
        };

    // Run all 3 queries in parallel (was 3 sequential awaits).
    const [totalAttended, attendances, allEligibleEvents] = await Promise.all([
      db.eventAttendance.count({ where: { accountId: account.id } }),
      db.eventAttendance.findMany({
        where: { accountId: account.id },
        orderBy: { scannedAt: "desc" },
        take: 50,
        select: {
          id: true,
          scannedAt: true,
          timeOutAt: true,
          source: true,
          event: {
            select: { id: true, title: true, scheduledAt: true, scope: true },
          },
        },
      }),
      db.event.findMany({
        where: eligibleBase,
        select: {
          id: true,
          scheduledAt: true,
          endsAt: true,
          checkInOpensAt: true,
          checkInClosesAt: true,
          timeOutOpensAt: true,
          timeOutClosesAt: true,
          enableTimeOut: true,
          status: true,
        },
      }),
    ]);

    // Filter out ended events using the shared time-window helper.
    const liveOrUpcoming = allEligibleEvents.filter((e) => {
      const ts = getTimeStatus(e);
      return ts === "live" || ts === "upcoming";
    });

    const needsProfile = studentNeedsProfile(account.program, account.section);

    const userRes = NextResponse.json({
      user: account,
      stats: { totalAttended, eligibleEvents: liveOrUpcoming.length },
      attendances,
      needsProfile,
    });
    userRes.headers.set(
      "Cache-Control",
      "private, no-cache, stale-while-revalidate=30",
    );
    return userRes;
  }

  // Organizer/Admin dashboard.
  const eventWhere =
    account.role === "ORGANIZER" ? { ownerId: account.id } : {};
  const attendanceWhere =
    account.role === "ORGANIZER" ? { event: { ownerId: account.id } } : {};
  const overrideWhere =
    account.role === "ORGANIZER" ? { adminId: account.id } : {};

  // Run all counts + recent events in parallel for faster dashboard load.
  const [totalStudents, totalEvents, totalScans, totalOverrides, recentEvents] =
    await Promise.all([
      db.authorizedStudent.count(),
      db.event.count({ where: { ...eventWhere, status: "active" } }),
      db.eventAttendance.count({ where: attendanceWhere }),
      db.attendanceOverride.count({ where: overrideWhere }),
      db.event.findMany({
        where: { ...eventWhere, status: "active" },
        orderBy: { scheduledAt: "desc" },
        take: 10,
        select: {
          id: true,
          title: true,
          scheduledAt: true,
          endsAt: true,
          checkInOpensAt: true,
          checkInClosesAt: true,
          timeOutOpensAt: true,
          timeOutClosesAt: true,
          enableTimeOut: true,
          status: true,
          targetProgram: true,
          targetSection: true,
          scope: true,
          _count: { select: { attendances: true } },
          owner: { select: { fullName: true } },
        },
      }),
    ]);

  // Filter recentEvents to only show live + upcoming (not ended).
  const liveOrUpcomingEvents = recentEvents.filter((e) => {
    const ts = getTimeStatus(e);
    return ts === "live" || ts === "upcoming";
  });

  const programGroups = await db.authorizedStudent.groupBy({
    by: ["program"],
    _count: true,
  });
  const sectionGroups = await db.authorizedStudent.groupBy({
    by: ["program", "section"],
    _count: true,
  });
  const programCounts: Record<string, number> = {};
  for (const g of programGroups) {
    programCounts[g.program] = g._count;
  }
  const sectionCounts: Record<string, number> = {};
  for (const g of sectionGroups) {
    const key = `${g.program} ${g.section}`;
    sectionCounts[key] = g._count;
  }

  const adminRes = NextResponse.json({
    user: account,
    stats: { totalStudents, totalEvents, totalScans, totalOverrides },
    recentEvents: liveOrUpcomingEvents.map((e) => {
      return {
        id: e.id,
        title: e.title,
        scheduledAt: e.scheduledAt,
        targetProgram: e.targetProgram,
        targetSection: e.targetSection,
        scope: e.scope,
        presentCount: e._count.attendances,
        owner: e.owner?.fullName ?? "—",
        timeStatus: getTimeStatus(e),
      };
    }),
    programCounts,
    sectionCounts,
  });
  adminRes.headers.set(
    "Cache-Control",
    "private, no-cache, stale-while-revalidate=30",
  );
  return adminRes;
}
