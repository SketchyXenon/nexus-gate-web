import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkCronAuth, checkBodySecret } from "@/lib/cron-auth";

// /api/cron/event-reminders
// Finds events starting within the next 30 min and creates notifications.
// Auth: Bearer header, Basic auth (cron-job.org password), custom header,
//       query param, or JSON body field. See src/lib/cron-auth.ts.

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

// Shared auth check with detailed logging (no secret values logged).
function authorizeCron(req: NextRequest): NextResponse | null {
  const result = checkCronAuth(req);
  if (result.ok) return null;

  // Log the failure reason + which method was attempted (no secret value).
  const cronSecretSet = Boolean((process.env.CRON_SECRET || "").trim());
  console.warn(
    `[cron/event-reminders] auth failed: ${result.reason}` +
      (result.method ? ` (method: ${result.method})` : "") +
      ` | CRON_SECRET set: ${cronSecretSet}` +
      ` | headers: ${JSON.stringify({
        authorization: req.headers.get("authorization")
          ? "[present]"
          : "[absent]",
        "x-cron-secret": req.headers.get("x-cron-secret")
          ? "[present]"
          : "[absent]",
        "x-cronjob-secret": req.headers.get("x-cronjob-secret")
          ? "[present]"
          : "[absent]",
      })}`,
  );

  return NextResponse.json(
    {
      error: "Unauthorized",
      code: "CRON_UNAUTHORIZED",
      hint: cronSecretSet
        ? "Auth methods: Bearer token, Basic auth (cron-job.org password), x-cron-secret header, ?secret= query param, or JSON body {secret}."
        : "CRON_SECRET env var is not set on the server.",
    },
    { status: 401 },
  );
}

export async function GET(req: NextRequest) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  const result = await runEventReminders();
  return NextResponse.json(
    { ok: true, ...result },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  // Try header/query auth first.
  const headerResult = checkCronAuth(req);
  if (!headerResult.ok) {
    // Fallback: try reading secret from JSON body (some cron services
    // send the secret in the request body rather than headers/URL).
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        const body = await req.json();
        if (checkBodySecret(body)) {
          const result = await runEventReminders();
          return NextResponse.json({ ok: true, ...result });
        }
      } catch {
        // Empty/invalid JSON — fall through to 401.
      }
    }
    return authorizeCron(req) ?? NextResponse.json({ ok: true });
  }

  const result = await runEventReminders();
  return NextResponse.json({ ok: true, ...result });
}
