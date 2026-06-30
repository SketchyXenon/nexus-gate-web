import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api";

// ====================================================================
// GET /api/notifications/status
// Returns whether the current user has notifications enabled.
// ====================================================================
export async function GET() {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  const full = await db.account.findUnique({
    where: { id: account.id },
    select: {
      notificationEnabled: true,
      notificationEndpoint: true,
    },
  });

  return NextResponse.json({
    enabled: full?.notificationEnabled ?? false,
    hasSubscription: !!full?.notificationEndpoint,
  });
}
