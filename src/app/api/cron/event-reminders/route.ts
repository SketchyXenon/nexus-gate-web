// Allow up to 30s for bulk reminder creation.
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkCronAuth, checkBodySecret } from "@/lib/cron-auth";
import { isDbUnavailableError } from "@/lib/api";
import { notifyDbFailure } from "@/lib/keep-alive";
import { eligibleAccountIdsForEvent } from "@/lib/event-targeting";

// /api/cron/event-reminders
// Finds events starting within the next 30 min and creates notifications.
// Auth: Bearer header, Basic auth (cron-job.org password), custom header,
//       query param, or JSON body field. See src/lib/cron-auth.ts.
//
// RESILIENCE (incident 2026-11-02): an external scheduler hits this
// route every 5 minutes. When TiDB connections failed (Prisma P2039
// "pool failed to retrieve a connection"), every run threw a raw 500
// with a full Prisma stack trace - six times in 30 minutes, with NO
// alert to the admin (the keep-alive watchdog only ran in the daily
// cleanup). Now: transient pool/connect failures get ONE retry after a
// short backoff; persistent DB failures return a structured 503 (clean
// logs, Retry-After for the scheduler) and trigger the keep-alive
// watchdog, which emails admins on the failure transition.

// Error signatures that are usually transient (pool churn, gateway
// hiccup, connection storm) - worth exactly one retry.
// HARDENING (pass 2026-11-02): "45028" is TiDB Cloud's pool-exhaustion
// error code and "retrieve a connection" is the mariadb-adapter pool
// message - both observed in production (P2039 incidents) in shapes
// where the top-level message text varied. Matching them here means the
// retry + structured-503 path also covers driver-native error text.
const TRANSIENT_DB_ERROR =
  /P2039|P1001|P2024|pool failed|retrieve a connection|45028|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i;

async function runEventRemindersWithRetry() {
  try {
    return await runEventReminders();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!TRANSIENT_DB_ERROR.test(msg)) throw e;
    // One retry after 1.5s: the pool's dead connections are typically
    // reaped within a second and a fresh connect attempt usually
    // succeeds. Total added latency stays far under maxDuration=30.
    console.error(
      `[cron/event-reminders] transient DB error, retrying once: ${msg.slice(0, 200)}`,
    );
    await new Promise((r) => setTimeout(r, 1_500));
    return await runEventReminders();
  }
}

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

  // Step 2: bulk-fetch all eligible students ONCE (was N+1 - one query
  // per event). Then distribute to events in memory.
  const allEligibleStudents = await db.account.findMany({
    where: {
      role: "USER",
      status: "ACTIVE",
      notificationEnabled: true,
    },
    select: { id: true, program: true, section: true },
  });

  // Step 3: resolve the audience per event. M3 FIX (hardening pass
  // 2026-11-02): targetProgram/targetSection are independently nullable,
  // so "program-only" and "section-only" events are legal - the old
  // inline filter silently skipped them (no reminders ever sent).
  // eligibleAccountIdsForEvent handles all four combinations; see
  // src/lib/event-targeting.ts for the exact semantics + tests.
  const eventConditions: Array<{
    event: (typeof upcomingEvents)[0];
    accountIds: string[];
  }> = upcomingEvents.map((event) => ({
    event,
    accountIds: eligibleAccountIdsForEvent(event, allEligibleStudents),
  }));

  // Step 4: collect all unique account IDs for the dedup query.
  const allAccountIds = Array.from(
    new Set(eventConditions.flatMap((ec) => ec.accountIds)),
  );

  // Step 5: bulk-fetch existing reminder notifications for dedup.
  // One query instead of N (one per student per event). Dedup is based on
  // the type field which encodes the eventId as "reminder:event:N" - this
  // avoids false-positive matches from the old title-substring check
  // (e.g. "Math" matching "Math Review").
  const existingReminders =
    allAccountIds.length > 0
      ? await db.notification.findMany({
          where: {
            accountId: { in: allAccountIds },
            type: { startsWith: "reminder:event:" },
            createdAt: { gt: new Date(now.getTime() - 60 * 60 * 1000) },
          },
          select: { accountId: true, type: true },
        })
      : [];

  // Build a Set of "accountId:eventId" keys for O(1) dedup lookup.
  const existingKeys = new Set<string>();
  for (const r of existingReminders) {
    // type format: "reminder:event:42"
    const eventIdStr = r.type.split(":")[2];
    if (eventIdStr) {
      existingKeys.add(`${r.accountId}:${eventIdStr}`);
    }
  }

  // Step 6: build the list of notifications to create.
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
          // Encode eventId in type for O(1) dedup on the next cron run.
          type: `reminder:event:${event.id}`,
        });
      }
    }
  }

  // Step 7: bulk insert all new notifications in one query.
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
  const result = checkCronAuth(req, "reminders");
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
  try {
    const result = await runEventRemindersWithRetry();
    return NextResponse.json(
      { ok: true, ...result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return handleRunnerError(e);
  }
}

/**
 * Shared failure path for GET/POST: structured 503 for DB
 * unavailability (with Retry-After so external schedulers back off
 * gracefully), watchdog trigger for minutes-level alerting, and a
 * rethrow for anything genuinely unexpected (still surfaces as a 500,
 * but that is now a code bug, not a DB blip).
 */
async function handleRunnerError(e: unknown): Promise<NextResponse> {
  const msg = e instanceof Error ? e.message : String(e);
  if (isDbUnavailableError(e) || TRANSIENT_DB_ERROR.test(msg)) {
    console.error(
      `[cron/event-reminders] DB unavailable after retry: ${msg.slice(0, 300)}`,
    );
    // Fire-and-forget: runs the keep-alive watchdog (throttled to once
    // per 60s in-process) which emails admins on the failure transition.
    await notifyDbFailure("cron/event-reminders");
    return NextResponse.json(
      {
        ok: false,
        code: "DB_UNAVAILABLE",
        error:
          "The database is temporarily unreachable. The run will be retried by the scheduler.",
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "60" },
      },
    );
  }
  throw e;
}

export async function POST(req: NextRequest) {
  // Try header/query auth first.
  const headerResult = checkCronAuth(req, "reminders");
  if (!headerResult.ok) {
    // Fallback: try reading secret from JSON body (some cron services
    // send the secret in the request body rather than headers/URL).
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        const body = await req.json();
        if (checkBodySecret(body, "reminders")) {
          try {
            const result = await runEventRemindersWithRetry();
            return NextResponse.json(
              { ok: true, ...result },
              // L5 (hardening pass 2026-11-02): POST responses are
              // scheduler-triggered and contain run counts - never cache.
              { headers: { "Cache-Control": "no-store" } },
            );
          } catch (e) {
            return handleRunnerError(e);
          }
        }
      } catch {
        // Empty/invalid JSON - fall through to 401.
      }
    }
    // Header/query auth failed and body-secret fallback failed. Re-check
    // via authorizeCron (returns a 401 response, or null if authorized).
    // If authorized, run the job - previously this returned ok:true WITHOUT
    // running the job (silent no-op). Fail closed: denied -> 401.
    const denied = authorizeCron(req);
    if (denied) return denied;
  }

  try {
    const result = await runEventRemindersWithRetry();
    return NextResponse.json(
      { ok: true, ...result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return handleRunnerError(e);
  }
}
