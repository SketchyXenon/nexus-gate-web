import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, notFound } from "@/lib/api";

// ====================================================================
// GET /api/notifications — list current user's notifications
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

  return NextResponse.json({
    notifications,
    unreadCount,
  }, { headers: { "Cache-Control": "private, no-cache" } });
}

// ====================================================================
// POST /api/notifications — mark all as read (or specific notification)
// Body: { notificationId?: number } — if omitted, marks all as read
// ====================================================================
export async function POST(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;

  const body = await req.json().catch(() => ({}));
  const now = new Date();

  if (body?.notificationId) {
    // Mark specific notification as read (must belong to the user)
    const notif = await db.notification.findFirst({
      where: { id: Number(body.notificationId), accountId: res.account.id },
    });
    if (!notif) return notFound("Notification not found");
    await db.notification.update({
      where: { id: Number(body.notificationId) },
      data: { readAt: now },
    });
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
