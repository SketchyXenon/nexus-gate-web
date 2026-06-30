import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// ====================================================================
// POST /api/cron/cleanup
//
// Called by Vercel Cron (daily at 3 AM) or manually.
// Removes:
//   - Expired verification tokens
//   - Revoked/expired refresh tokens
//   - Old read notifications (>30 days)
//
// Vercel Cron config:
//   { "path": "/api/cron/cleanup", "schedule": "0 3 * * *" }
// ====================================================================

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  // FAIL CLOSED: if CRON_SECRET is not set, reject ALL requests.
  // This prevents anyone from triggering bulk token deletion.
  if (!cronSecret) {
    console.error("[cron/cleanup] CRON_SECRET is not set — refusing to execute.");
    return NextResponse.json({ error: "Service misconfigured" }, { status: 503 });
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [tokensDeleted, refreshDeleted, oldNotifications] = await Promise.all([
    // Expired/used verification tokens
    db.verificationToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: now } },
          { usedAt: { not: null } },
        ],
      },
    }),
    // Expired or revoked refresh tokens
    db.refreshToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: now } },
          { revokedAt: { not: null } },
        ],
      },
    }),
    // Old read notifications (>30 days)
    db.notification.deleteMany({
      where: {
        readAt: { lt: thirtyDaysAgo },
      },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    deleted: {
      verificationTokens: tokensDeleted.count,
      refreshTokens: refreshDeleted.count,
      oldNotifications: oldNotifications.count,
    },
    timestamp: now.toISOString(),
  });
}
