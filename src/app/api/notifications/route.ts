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
  // L3 fix: cursor-based pagination. The client passes the createdAt of the
  // OLDEST notification in the current list as ?cursor=<iso>. We return the
  // next page of older notifications + a hasMore flag. Default page size 50
  // (matches the old hard cap), max 100 to prevent abuse.
  const cursor = searchParams.get("cursor");
  const limit = Math.min(Number(searchParams.get("limit")) || 50, 100);

  const where: Record<string, unknown> = {
    accountId: res.account.id,
  };
  if (unreadOnly) {
    where.readAt = null;
  }
  if (cursor) {
    const cursorDate = new Date(cursor);
    if (!isNaN(cursorDate.getTime())) {
      where.createdAt = { lt: cursorDate };
    }
  }

  // Fetch limit+1 to detect if there's another page (hasMore).
  const [rows, unreadCount] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
    }),
    db.notification.count({
      where: {
        accountId: res.account.id,
        readAt: null,
      },
    }),
  ]);

  const hasMore = rows.length > limit;
  const notifications = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore
    ? notifications[notifications.length - 1]?.createdAt.toISOString()
    : null;

  return NextResponse.json(
    {
      notifications,
      unreadCount,
      hasMore,
      nextCursor,
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
