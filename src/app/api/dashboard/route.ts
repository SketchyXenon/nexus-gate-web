import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api";
import { getTimeStatus } from "@/lib/event-time";
import {
  studentNeedsProfile,
  visibleEventWhereOr,
} from "@/lib/event-visibility";

// GET /api/dashboard
// Short cache to reduce DB load on repeated page loads (30s stale-while-revalidate).
export async function GET(_req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  if (account.role === "USER") {
    // v8: open-to-all, program-wide in the student's program, or exact
    // program+section match. Organizers' program-scoped events now reach
    // every student in that program.
    const eligibleBase = {
      status: "active" as const,
      OR: visibleEventWhereOr(account.program, account.section),
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
    userRes.headers.set("Cache-Control", "private, no-cache");
    return userRes;
  }

  // Organizer/Admin dashboard.
  const eventWhere =
    account.role === "ORGANIZER" ? { ownerId: account.id } : {};
  const attendanceWhere =
    account.role === "ORGANIZER" ? { event: { ownerId: account.id } } : {};
  // v16: overrides on events the organizer OWNS (event-scoped, consistent
  // with GET /api/attendance/overrides). Was { adminId } - both the field
  // (renamed to creatorId in v16) and the semantics were wrong: it
  // counted entries CREATED BY the organizer rather than entries on
  // their events.
  const overrideWhere =
    account.role === "ORGANIZER" ? { event: { ownerId: account.id } } : {};

  // L2 fix: scope roster counts to the caller's own program + section when
  // they're an ORGANIZER (was leaking the ENTIRE student body's counts to
  // every organizer). Admins still see all. An organizer only manages
  // students in their own program/section, so the global counts were both
  // irrelevant and an info leak.
  const isOrganizer = account.role === "ORGANIZER";
  const rosterWhere = isOrganizer
    ? {
        OR: [
          { program: account.program ?? "__none__" },
          {
            AND: [
              { program: account.program ?? "__none__" },
              { section: account.section ?? "__none__" },
            ],
          },
        ],
      }
    : {};

  // Run all counts + recent events in parallel for faster dashboard load.
  // totalTimedOut counts attendance rows where the student also timed out
  // (timeOutAt set) within the caller's event scope.
  const [
    totalStudents,
    totalEvents,
    totalScans,
    totalTimedOut,
    totalOverrides,
    recentEvents,
  ] = await Promise.all([
    db.authorizedStudent.count({ where: rosterWhere }),
    db.event.count({ where: { ...eventWhere, status: "active" } }),
    db.eventAttendance.count({ where: attendanceWhere }),
    db.eventAttendance.count({
      where: { ...attendanceWhere, timeOutAt: { not: null } },
    }),
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

  // Per-event timed-out counts for the recent-events list. Prisma relation
  // counts support only one filter per relation, so the timeOutAt-filtered
  // count is fetched via groupBy over the visible events and merged in.
  const timedOutByEvent = new Map<number, number>();
  if (liveOrUpcomingEvents.length > 0) {
    const timedOutGroups = await db.eventAttendance.groupBy({
      by: ["eventId"],
      where: {
        eventId: { in: liveOrUpcomingEvents.map((e) => e.id) },
        timeOutAt: { not: null },
      },
      _count: { _all: true },
    });
    for (const g of timedOutGroups) {
      timedOutByEvent.set(g.eventId, g._count._all);
    }
  }

  // Per 02-system-design.md §5 "Scalability": parallelize independent
  // queries. The program + section groupBys are independent of each other
  // (both read the same roster) — running them concurrently saves 1 DB
  // round-trip per dashboard load.
  const [programGroups, sectionGroups] = await Promise.all([
    db.authorizedStudent.groupBy({
      by: ["program"],
      where: rosterWhere,
      _count: true,
    }),
    db.authorizedStudent.groupBy({
      by: ["program", "section"],
      where: rosterWhere,
      _count: true,
    }),
  ]);
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
    stats: {
      totalStudents,
      totalEvents,
      totalScans,
      totalTimedOut,
      totalOverrides,
    },
    recentEvents: liveOrUpcomingEvents.map((e) => {
      return {
        id: e.id,
        title: e.title,
        scheduledAt: e.scheduledAt,
        targetProgram: e.targetProgram,
        targetSection: e.targetSection,
        scope: e.scope,
        presentCount: e._count.attendances,
        timedOutCount: timedOutByEvent.get(e.id) ?? 0,
        enableTimeOut: e.enableTimeOut,
        timeOutOpensAt: e.timeOutOpensAt,
        timeOutClosesAt: e.timeOutClosesAt,
        owner: e.owner?.fullName ?? " - ",
        timeStatus: getTimeStatus(e),
      };
    }),
    programCounts,
    sectionCounts,
  });
  adminRes.headers.set("Cache-Control", "private, no-cache");
  return adminRes;
}
