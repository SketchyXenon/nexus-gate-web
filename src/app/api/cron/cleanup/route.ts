import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// /api/cron/cleanup
// Removes expired tokens + old notifications.
// Auth: Bearer header (Vercel Cron) OR ?secret= query param (cron-job.org).

function checkCronAuth(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron/cleanup] CRON_SECRET env var is not set");
    return false;
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token === cronSecret) return true;
  }

  const url = new URL(req.url);
  const querySecret = url.searchParams.get("secret");
  if (querySecret) {
    if (querySecret.trim() === cronSecret) return true;
  }

  return false;
}

async function runCleanup() {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [tokensDeleted, refreshDeleted, oldNotifications] = await Promise.all([
    db.verificationToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
    }),
    db.refreshToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }] },
    }),
    db.notification.deleteMany({
      where: { readAt: { lt: thirtyDaysAgo } },
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

export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runCleanup();
  return NextResponse.json({ ok: true, ...result });
}

export async function POST(req: NextRequest) {
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runCleanup();
  return NextResponse.json({ ok: true, ...result });
}
