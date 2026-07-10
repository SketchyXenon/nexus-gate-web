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

  // Step 1: fetch all upcoming events in one query.
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

  if (upcomingEvents.length === 0) {
    return {
      checkedEvents: 0,
      notificationsCreated: 0,
      timestamp: now.toISOString(),
    };
  }

  // Step 2: build OR conditions for all eligible student sets in one query.
  // Each event contributes either an exact (program, section) match or
  // open-to-all. We collect all eligible account IDs per event.
  const eventConditions: Array<{
    event: (typeof upcomingEvents)[0];
    accountIds: string[];
  }> = [];

  for (const event of upcomingEvents) {
    if (event.targetProgram && event.targetSection) {
      // Exact program + section match.
      const students = await db.account.findMany({
        where: {
          role: "USER",
          status: "ACTIVE",
          notificationEnabled: true,
          program: event.targetProgram,
          section: event.targetSection,
        },
        select: { id: true },
      });
      eventConditions.push({ event, accountIds: students.map((s) => s.id) });
    } else if (!event.targetProgram && !event.targetSection) {
      // Open to all — fetch all eligible students.
      const students = await db.account.findMany({
        where: {
          role: "USER",
          status: "ACTIVE",
          notificationEnabled: true,
        },
        select: { id: true },
      });
      eventConditions.push({ event, accountIds: students.map((s) => s.id) });
    }
    // Events with only program OR only section (not both) are skipped —
    // matches the original behavior.
  }

  // Step 3: collect all unique account IDs for the dedup query.
  const allAccountIds = Array.from(
    new Set(eventConditions.flatMap((ec) => ec.accountIds)),
  );

  // Step 4: bulk-fetch existing reminder notifications for dedup.
  // One query instead of N (one per student per event).
  const existingReminders =
    allAccountIds.length > 0
      ? await db.notification.findMany({
          where: {
            accountId: { in: allAccountIds },
            type: "reminder",
            createdAt: { gt: new Date(now.getTime() - 60 * 60 * 1000) }, // last hour
          },
          select: { accountId: true, body: true },
        })
      : [];

  // Build a Set of "accountId:eventTitle" keys for O(1) dedup lookup.
  const existingKeys = new Set<string>();
  for (const r of existingReminders) {
    for (const ec of eventConditions) {
      if (r.body.includes(ec.event.title)) {
        existingKeys.add(`${r.accountId}:${ec.event.id}`);
      }
    }
  }

  // Step 5: build the list of notifications to create.
  const toCreate: Array<{
    accountId: string;
    title: string;
    body: string;
    type: string;
  }> = [];

  for (const { event, accountIds } of eventConditions) {
    const minutesUntil = Math.round(
      (event.scheduledAt.getTime() - now.getTime()) / (60 * 1000),
    );
    const body = `"${event.title}" starts in ${minutesUntil} minute${minutesUntil === 1 ? "" : "s"}. Don't forget to check in!`;
    for (const accountId of accountIds) {
      const key = `${accountId}:${event.id}`;
      if (!existingKeys.has(key)) {
        toCreate.push({
          accountId,
          title: "Upcoming class",
          body,
          type: "reminder",
        });
      }
    }
  }

  // Step 6: bulk insert all new notifications in one query.
  let notificationsCreated = 0;
  if (toCreate.length > 0) {
    const result = await db.notification.createMany({ data: toCreate });
    notificationsCreated = result.count;
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
