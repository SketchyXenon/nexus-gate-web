import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api";
import { getTimeStatus, getEventTimeWindow } from "@/lib/event-time";
import { studentNeedsProfile } from "@/lib/event-visibility";

// GET /api/dashboard
export async function GET(_req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  if (account.role === "USER") {
    // Use count() instead of take:50 + .length for an accurate total.
    const totalAttended = await db.eventAttendance.count({
      where: { accountId: account.id },
    });

    // Recent attendances (for the list display, limited to 50).
    const attendances = await db.eventAttendance.findMany({
      where: { accountId: account.id },
      orderBy: { scannedAt: "desc" },
      take: 50,
      include: {
        event: {
          select: { id: true, title: true, scheduledAt: true, scope: true },
        },
      },
    });

    // Eligible events: only LIVE or UPCOMING (not ended).
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

    const allEligibleEvents = await db.event.findMany({
      where: eligibleBase,
      select: {
        id: true,
        scheduledAt: true,
        endsAt: true,
        checkInOpensAt: true,
        checkInClosesAt: true,
        status: true,
      },
    });

    // Filter out ended events using the shared time-window helper.
    const liveOrUpcoming = allEligibleEvents.filter((e) => {
      const ts = getTimeStatus(e);
      return ts === "live" || ts === "upcoming";
    });

    const needsProfile = studentNeedsProfile(account.program, account.section);

    return NextResponse.json({
      user: account,
      stats: { totalAttended, eligibleEvents: liveOrUpcoming.length },
      attendances,
      needsProfile,
    });
  }

  // Organizer/Admin dashboard.
  const eventWhere =
    account.role === "ORGANIZER" ? { ownerId: account.id } : {};
  const [totalStudents, totalEvents, totalScans, totalOverrides] =
    await Promise.all([
      db.authorizedStudent.count(),
      db.event.count({ where: { ...eventWhere, status: "active" } }),
      db.eventAttendance.count({
        where:
          account.role === "ORGANIZER"
            ? { event: { ownerId: account.id } }
            : {},
      }),
      db.attendanceOverride.count({
        where: account.role === "ORGANIZER" ? { adminId: account.id } : {},
      }),
    ]);

  const recentEvents = await db.event.findMany({
    where: { ...eventWhere, status: "active" },
    orderBy: { scheduledAt: "desc" },
    take: 10,
    include: {
      _count: { select: { attendances: true } },
      owner: { select: { fullName: true } },
    },
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

  return NextResponse.json({
    user: account,
    stats: { totalStudents, totalEvents, totalScans, totalOverrides },
    recentEvents: recentEvents.map((e) => {
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
}
