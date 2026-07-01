import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { timingSafeCompareHex } from "@/lib/timing-safe";

// ====================================================================
// /api/cron/event-reminders
// --------------------------------------------------------------------
// Called by Vercel Cron (daily at 8 AM) or manually.
// Finds events starting within the next 30 minutes and creates
// notification records for eligible students who haven't been notified.
//
// Auth: Vercel Cron auto-sends "Authorization: Bearer $CRON_SECRET"
// when the env var is set. This route checks that header with a
// constant-time comparison to prevent timing attacks. If CRON_SECRET
// is unset, the route returns 503 (fail-closed).
// ====================================================================

function checkCronAuth(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  return timingSafeCompareHex(authHeader.slice(7), cronSecret);
}

async function runEventReminders() {
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

    // Check if we already sent a reminder for this event (dedup)
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

  return { checkedEvents: upcomingEvents.length, notificationsCreated, timestamp: now.toISOString() };
}

// GET — for Vercel Cron (which can't send POST or custom headers)
export async function GET(req: NextRequest) {
  if (!process.env.CRON_SECRET) {
    console.error("[cron/event-reminders] CRON_SECRET is not set — refusing to execute.");
    return NextResponse.json({ error: "Service misconfigured" }, { status: 503 });
  }
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runEventReminders();
  return NextResponse.json({ ok: true, ...result });
}

// POST — for manual invocation (curl with Authorization header)
export async function POST(req: NextRequest) {
  if (!process.env.CRON_SECRET) {
    console.error("[cron/event-reminders] CRON_SECRET is not set — refusing to execute.");
    return NextResponse.json({ error: "Service misconfigured" }, { status: 503 });
  }
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runEventReminders();
  return NextResponse.json({ ok: true, ...result });
}
