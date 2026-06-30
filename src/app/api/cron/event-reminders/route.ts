import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// ====================================================================
// POST /api/cron/event-reminders
//
// Called by Vercel Cron (every 5 minutes) or manually.
// Finds events starting within the next 30 minutes and creates
// notification records for eligible students who haven't been
// notified yet.
//
// Security: protected by CRON_SECRET env var.
//
// Vercel Cron config (vercel.json):
//   {
//     "crons": [
//       { "path": "/api/cron/event-reminders", "schedule": "*/5 * * * *" }
//     ]
//   }
// ====================================================================

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  // FAIL CLOSED: if CRON_SECRET is not set, reject ALL requests.
  if (!cronSecret) {
    console.error("[cron/event-reminders] CRON_SECRET is not set — refusing to execute.");
    return NextResponse.json({ error: "Service misconfigured" }, { status: 503 });
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const THIRTY_MIN = 30 * 60 * 1000;
  const windowEnd = new Date(now.getTime() + THIRTY_MIN);

  // Find active events starting within the next 30 minutes
  const upcomingEvents = await db.event.findMany({
    where: {
      status: "active",
      scheduledAt: {
        gt: now,
        lt: windowEnd,
      },
    },
    select: {
      id: true,
      title: true,
      scheduledAt: true,
      targetProgram: true,
      targetSection: true,
    },
  });

  let notificationsCreated = 0;

  for (const event of upcomingEvents) {
    // Find eligible students (active accounts with matching program/section)
    const where: Record<string, unknown> = {
      role: "USER",
      status: "ACTIVE",
      notificationEnabled: true,
    };

    if (event.targetProgram) {
      where.program = event.targetProgram;
    }
    if (event.targetSection) {
      where.section = event.targetSection;
    }

    const students = await db.account.findMany({
      where,
      select: { id: true },
    });

    // Check if we already sent a reminder for this event
    // (avoid duplicate notifications)
    for (const student of students) {
      const existing = await db.notification.findFirst({
        where: {
          accountId: student.id,
          type: "reminder",
          body: { contains: event.title },
        },
      });

      if (!existing) {
        const minutesUntil = Math.round(
          (event.scheduledAt.getTime() - now.getTime()) / (60 * 1000)
        );

        await db.notification.create({
          data: {
            accountId: student.id,
            title: "Upcoming class",
            body: `"${event.title}" starts in ${minutesUntil} minute${minutesUntil === 1 ? "" : "s"}. Don't forget to check in!`,
            type: "reminder",
          },
        });
        notificationsCreated++;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    checkedEvents: upcomingEvents.length,
    notificationsCreated,
    timestamp: now.toISOString(),
  });
}
