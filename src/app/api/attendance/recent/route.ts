import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api";
import { hasMinimumRole } from "@/lib/rbac";

// GET /api/attendance/recent
// Returns the latest attendance records across events the caller can see.
// Admin sees all; organizer sees only their own events' attendance.
// Query params: ?limit=20 (max 50, default 20)

export async function GET(req: NextRequest) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;

  const sp = req.nextUrl.searchParams;
  const limit = Math.min(50, Math.max(1, Number(sp.get("limit")) || 20));

  // Build the where clause based on role.
  const where = hasMinimumRole(account.role, "ADMIN")
    ? {} // Admin sees all attendance records.
    : { event: { ownerId: account.id } }; // Organizer sees only own events.

  const records = await db.eventAttendance.findMany({
    where,
    orderBy: { scannedAt: "desc" },
    take: limit,
    select: {
      id: true,
      scannedAt: true,
      source: true,
      event: {
        select: {
          id: true,
          title: true,
          scheduledAt: true,
          targetProgram: true,
          targetSection: true,
        },
      },
      account: {
        select: {
          id: true,
          fullName: true,
          studentId: true,
          program: true,
          section: true,
        },
      },
    },
  });

  return NextResponse.json(
    { records },
    {
      headers: {
        "Cache-Control": "private, no-cache, stale-while-revalidate=15",
      },
    },
  );
}
