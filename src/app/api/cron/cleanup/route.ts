// Allow up to 30s for bulk cleanup deletes.
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkCronAuth, checkBodySecret } from "@/lib/cron-auth";
import { isDbUnavailableError } from "@/lib/api";
import { notifyDbFailure, runKeepAlive } from "@/lib/keep-alive";

// /api/cron/cleanup
// Removes expired tokens + old notifications.
// Auth: Bearer header, Basic auth (cron-job.org password), custom header,
//       query param, or JSON body field. See src/lib/cron-auth.ts.

async function runCleanup() {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  // Attendance: 365 days (one full academic year). Previously 180 days,
  // which deleted records mid-year for schools on a June-April calendar.
  const attendanceCutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  // Audit logs: 365 days. ARCHITECTURE.md calls the audit log an
  // "append-only accountability trail"; 90 days was too short for an
  // academic-year compliance window. 365 days balances accountability
  // with storage growth.
  const auditCutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

  const [
    tokensDeleted,
    refreshDeleted,
    oldNotifications,
    oldAttendance,
    oldAuditLogs,
  ] = await Promise.all([
    db.verificationToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
    }),
    db.refreshToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }] },
    }),
    // Notifications: purge read notifications > 30 days, AND unread
    // notifications > 365 days (prevents unbounded growth of unread
    // notifications that users never dismiss).
    db.notification.deleteMany({
      where: {
        OR: [
          { readAt: { lt: thirtyDaysAgo } },
          { readAt: null, createdAt: { lt: auditCutoff } },
        ],
      },
    }),
    // Purge event_attendance older than 365 days (one academic year).
    db.eventAttendance.deleteMany({
      where: { scannedAt: { lt: attendanceCutoff } },
    }),
    // Purge audit_logs older than 365 days.
    db.auditLog.deleteMany({
      where: { createdAt: { lt: auditCutoff } },
    }),
  ]);

  return {
    deleted: {
      verificationTokens: tokensDeleted.count,
      refreshTokens: refreshDeleted.count,
      oldNotifications: oldNotifications.count,
      oldAttendance: oldAttendance.count,
      oldAuditLogs: oldAuditLogs.count,
    },
    timestamp: now.toISOString(),
  };
}

// Error signatures that are usually transient (pool churn, gateway
// hiccup, connection storm) - worth exactly one retry.
// HARDENING (pass 2026-11-02): "45028" is TiDB Cloud's pool-exhaustion
// error code and "retrieve a connection" is the mariadb-adapter pool
// message - both observed in production (P2039 incidents) in shapes
// where the top-level message text varied. Matching them here means the
// retry + structured-503 path also covers driver-native error text.
const TRANSIENT_DB_ERROR =
  /P2039|P1001|P2024|pool failed|retrieve a connection|45028|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i;

async function runCleanupWithRetry() {
  try {
    return await runCleanup();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!TRANSIENT_DB_ERROR.test(msg)) throw e;
    console.error(
      `[cron/cleanup] transient DB error, retrying once: ${msg.slice(0, 200)}`,
    );
    await new Promise((r) => setTimeout(r, 1_500));
    return await runCleanup();
  }
}

/**
 * Runs the daily cleanup, then the dependency keep-alive watchdog.
 *
 * WHY EMBEDDED (docs/supabase-keep-alive.md §2 M2): Vercel Hobby caps
 * cron jobs at 2 and both slots are used - a third vercel.json entry
 * would fail the deploy. The Supabase pause-protection ping therefore
 * rides along with the daily cleanup run. It never throws and never
 * changes the cleanup result: if the watchdog fails, cleanup still
 * reports ok (they guard different dependencies).
 *
 * INCIDENT FIX (2026-11-02): if the cleanup DB queries fail, the old
 * code aborted BEFORE the watchdog ran - so a TiDB outage suppressed
 * the very alert that would have reported it. The watchdog now runs
 * FIRST on the failure path: runKeepAlive is independent of cleanup
 * (separate probes + its own DB ping) and its alert state machine
 * decides whether to email admins.
 */
async function runCleanupWithKeepAlive() {
  const result = await runCleanupWithRetry();
  const keepAlive = await runKeepAlive();
  return { ...result, keepAlive };
}

/**
 * Shared failure path: structured 503 + watchdog trigger on DB
 * unavailability, rethrow for genuinely unexpected errors (code bugs).
 */
async function handleRunnerError(e: unknown): Promise<NextResponse> {
  const msg = e instanceof Error ? e.message : String(e);
  if (isDbUnavailableError(e) || TRANSIENT_DB_ERROR.test(msg)) {
    console.error(
      `[cron/cleanup] DB unavailable after retry: ${msg.slice(0, 300)}`,
    );
    // The watchdog run IS the alerting path here - it re-probes the DB
    // (with its own bounded ping) and emails admins on the transition.
    await notifyDbFailure("cron/cleanup");
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

function authorizeCron(req: NextRequest): NextResponse | null {
  const result = checkCronAuth(req, "cleanup");
  if (result.ok) return null;
  const cronSecretSet = Boolean((process.env.CRON_SECRET || "").trim());
  console.warn(
    `[cron/cleanup] auth failed: ${result.reason}` +
      (result.method ? ` (method: ${result.method})` : "") +
      ` | CRON_SECRET set: ${cronSecretSet}`,
  );
  return NextResponse.json(
    {
      error: "Unauthorized",
      code: "CRON_UNAUTHORIZED",
      hint: cronSecretSet
        ? "Auth methods: Bearer token, Basic auth, x-cron-secret header, ?secret= query param, or JSON body."
        : "CRON_SECRET env var is not set on the server.",
    },
    { status: 401 },
  );
}

export async function GET(req: NextRequest) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  try {
    const result = await runCleanupWithKeepAlive();
    return NextResponse.json(
      { ok: true, ...result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return handleRunnerError(e);
  }
}

export async function POST(req: NextRequest) {
  // Try header/query auth first.
  const headerResult = checkCronAuth(req, "cleanup");
  if (!headerResult.ok) {
    // Fallback: try reading secret from JSON body.
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        const body = await req.json();
        if (checkBodySecret(body, "cleanup")) {
          try {
            const result = await runCleanupWithKeepAlive();
            return NextResponse.json(
              { ok: true, ...result },
              // L5 (hardening pass 2026-11-02): never cache cron responses.
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
    // Fail closed: if still unauthorized, authorizeCron returns a 401.
    // If authorized, fall through and run the job (previously returned
    // ok:true without running it - silent no-op).
    const denied = authorizeCron(req);
    if (denied) return denied;
  }

  try {
    const result = await runCleanupWithKeepAlive();
    return NextResponse.json(
      { ok: true, ...result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return handleRunnerError(e);
  }
}
