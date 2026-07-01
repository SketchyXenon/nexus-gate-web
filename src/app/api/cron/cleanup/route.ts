import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// ====================================================================
// /api/cron/cleanup
// --------------------------------------------------------------------
// Called by Vercel Cron (daily at 3 AM — see vercel.json) OR manually.
// Removes:
//   - Expired verification tokens
//   - Revoked/expired refresh tokens
//   - Old read notifications (>30 days)
//
// IMPORTANT — Vercel Cron uses GET, not POST:
//   This route accepts BOTH GET (Vercel Cron) and POST (manual curl),
//   and accepts the secret via EITHER:
//     - Authorization: Bearer <secret> header (manual curl)
//     - ?secret=<secret> query param (Vercel Cron can't send headers)
//
// Security: protected by CRON_SECRET env var. If unset → 503 (fail-closed).
// ====================================================================

function checkCronAuth(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;

  const authHeader = req.headers.get("authorization");
  if (authHeader === `Bearer ${cronSecret}`) return true;

  const url = new URL(req.url);
  const querySecret = url.searchParams.get("secret");
  if (querySecret && querySecret === cronSecret) return true;

  return false;
}

async function runCleanup() {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [tokensDeleted, refreshDeleted, oldNotifications] = await Promise.all([
    // Expired/used verification tokens
    db.verificationToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }],
      },
    }),
    // Expired or revoked refresh tokens
    db.refreshToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }],
      },
    }),
    // Old read notifications (>30 days)
    db.notification.deleteMany({
      where: {
        readAt: { lt: thirtyDaysAgo },
      },
    }),
  ]);

  return {
    deleted: {
      verificationTokens: tokensDeleted.count,
      refreshTokens: refreshDeleted.count,
      oldNotifications: oldNotifications.count,
    },
    timestamp: now.toISOString(),
  };
}

// GET — for Vercel Cron (which can't send POST or custom headers)
export async function GET(req: NextRequest) {
  if (!process.env.CRON_SECRET) {
    console.error(
      "[cron/cleanup] CRON_SECRET is not set — refusing to execute.",
    );
    return NextResponse.json(
      { error: "Service misconfigured" },
      { status: 503 },
    );
  }
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runCleanup();
  return NextResponse.json({ ok: true, ...result });
}

// POST — for manual invocation (curl with Authorization header)
export async function POST(req: NextRequest) {
  if (!process.env.CRON_SECRET) {
    console.error(
      "[cron/cleanup] CRON_SECRET is not set — refusing to execute.",
    );
    return NextResponse.json(
      { error: "Service misconfigured" },
      { status: 503 },
    );
  }
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runCleanup();
  return NextResponse.json({ ok: true, ...result });
}
