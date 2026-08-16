import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, notFound } from "@/lib/api";

// ====================================================================
// GET /api/notifications - list current user's notifications
// Returns unread + recent read notifications.
// ====================================================================
export async function GET(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;

  const { searchParams } = new URL(req.url);
  const unreadOnly = searchParams.get("unread") === "true";

  const where: Record<string, unknown> = {
    accountId: res.account.id,
  };
  if (unreadOnly) {
    where.readAt = null;
  }

  // Run the list + count queries in parallel (was sequential).
  const [notifications, unreadCount] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    db.notification.count({
      where: {
        accountId: res.account.id,
        readAt: null,
      },
    }),
  ]);

  return NextResponse.json(
    {
      notifications,
      unreadCount,
    },
    { headers: { "Cache-Control": "private, no-cache" } },
  );
}

// ====================================================================
// POST /api/notifications - mark all as read (or specific notification)
// Body: { notificationId?: number } - if omitted, marks all as read
// ====================================================================
export async function POST(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;

  const body = await req.json().catch(() => ({}));
  const now = new Date();

  if (body?.notificationId) {
    // Mark specific notification as read. Atomic conditional update guards
    // the read-then-write TOCTOU (a concurrent change to ownership/readAt
    // between findFirst and update). The WHERE clause enforces both
    // ownership (accountId) and idempotency (only unread rows update);
    // 0 affected rows means not-found OR already-read - both return 404
    // because the client should see the same outcome either way.
    const upd = await db.notification.updateMany({
      where: {
        id: Number(body.notificationId),
        accountId: res.account.id,
        readAt: null,
      },
      data: { readAt: now },
    });
    if (upd.count === 0) return notFound("Notification not found");
  } else {
    // Mark all as read
    await db.notification.updateMany({
      where: {
        accountId: res.account.id,
        readAt: null,
      },
      data: { readAt: now },
    });
  }

  return NextResponse.json({ ok: true });
}
