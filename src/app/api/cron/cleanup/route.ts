import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { timingSafeCompareHex } from "@/lib/timing-safe";

// /api/cron/cleanup
// Removes expired tokens + old notifications.
// Auth: Bearer header (Vercel Cron) OR ?secret= query param (cron-job.org).

function checkCronAuth(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error(
      "[cron] CRON_SECRET env var is not set - refusing to authenticate.",
    );
    return false;
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token.length === cronSecret.length) {
      return timingSafeCompareHex(token, cronSecret);
    }
  }

  const url = new URL(req.url);
  const querySecret = url.searchParams.get("secret");
  if (querySecret) {
    if (querySecret.length === cronSecret.length) {
      return timingSafeCompareHex(querySecret, cronSecret);
    }
    console.warn(
      `[cron] query secret length mismatch: got ${querySecret.length}, expected ${cronSecret.length}`,
    );
  }

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
