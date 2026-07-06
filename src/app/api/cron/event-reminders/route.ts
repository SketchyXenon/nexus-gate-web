import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

// /api/cron/event-reminders
// Finds events starting within the next 30 min and creates notifications.
// Auth: Bearer header (Vercel Cron) OR ?secret= query param (cron-job.org).

async function runEventReminders() {
  const now = new Date();
  const THIRTY_MIN = 30 * 60 * 1000;
  const windowEnd = new Date(now.getTime() + THIRTY_MIN);

  const upcomingEvents = await db.event.findMany({
    where: {
      status: "active",
      scheduledAt: { gt: now, lt: windowEnd },
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
    const where: Record<string, unknown> = {
      role: "USER",
      status: "ACTIVE",
      notificationEnabled: true,
    };

    if (event.targetProgram && event.targetSection) {
      where.program = event.targetProgram;
      where.section = event.targetSection;
    } else if (!event.targetProgram && !event.targetSection) {
      // Open to all.
    } else {
      continue;
    }

    const students = await db.account.findMany({ where, select: { id: true } });

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
          (event.scheduledAt.getTime() - now.getTime()) / (60 * 1000),
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

  return {
    checkedEvents: upcomingEvents.length,
    notificationsCreated,
    timestamp: now.toISOString(),
  };
}

export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    if (!process.env.CRON_SECRET?.trim()) {
      console.error("[cron/event-reminders] CRON_SECRET env var is not set");
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runEventReminders();
  return NextResponse.json({ ok: true, ...result });
}

export async function POST(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    if (!process.env.CRON_SECRET?.trim()) {
      console.error("[cron/event-reminders] CRON_SECRET env var is not set");
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runEventReminders();
  return NextResponse.json({ ok: true, ...result });
}
