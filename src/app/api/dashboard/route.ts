import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api";
import { getTimeStatus } from "@/lib/event-time";
import { studentNeedsProfile } from "@/lib/event-visibility";

// GET /api/dashboard
export async function GET(_req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  if (account.role === "USER") {
    const attendances = await db.eventAttendance.findMany({
      where: { accountId: account.id },
      orderBy: { scannedAt: "desc" },
      take: 50,
      include: { event: { select: { id: true, title: true, scheduledAt: true, scope: true } } },
    });

    // ---- STRICT course/section alignment (mirrors GET /api/events v7) ----
    // A student counts as "eligible" for an event if:
    //   1. OPEN TO ALL (targetProgram AND targetSection both null), OR
    //   2. EXACT program + section match.
    // Program-wide events (targetSection null, targetProgram set) are NOT
    // eligible under the strict rule.
    const hasProgramAndSection = !!account.program && !!account.section;
    const eligibleWhere = hasProgramAndSection
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

    const eligibleEvents = await db.event.count({ where: eligibleWhere });

    const needsProfile = studentNeedsProfile(account.program, account.section);

    return NextResponse.json({
      user: account,
      stats: { totalAttended: attendances.length, eligibleEvents },
      attendances,
      needsProfile,
    });
  }

  const eventWhere = account.role === "ORGANIZER" ? { ownerId: account.id } : {};
  const [totalStudents, totalEvents, totalScans, totalOverrides] = await Promise.all([
    db.authorizedStudent.count(),
    db.event.count({ where: { ...eventWhere, status: "active" } }),
    db.eventAttendance.count({
      where: account.role === "ORGANIZER" ? { event: { ownerId: account.id } } : {},
    }),
    db.attendanceOverride.count({
      where: account.role === "ORGANIZER" ? { adminId: account.id } : {},
    }),
  ]);

  const recentEvents = await db.event.findMany({
    where: { ...eventWhere, status: "active" },
    orderBy: { scheduledAt: "desc" },
    take: 10,
    include: { _count: { select: { attendances: true } }, owner: { select: { fullName: true } } },
  });
  // Note: endsAt is included by default since it's a scalar field on Event

  // Use groupBy instead of loading all students into memory
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
        id: e.id, title: e.title, scheduledAt: e.scheduledAt,
        targetProgram: e.targetProgram, targetSection: e.targetSection, scope: e.scope,
        presentCount: e._count.attendances, owner: e.owner?.fullName ?? "—",
        timeStatus: getTimeStatus(e),
      };
    }),
    programCounts, sectionCounts,
  });
}
