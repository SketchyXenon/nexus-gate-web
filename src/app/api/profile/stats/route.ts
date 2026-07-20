// Allow up to 10s for the aggregation.
export const maxDuration = 10;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api";

// GET /api/profile/stats
// Returns attendance statistics for the calling student (USER role only):
//   scansByMonth: [{ month: "YYYY-MM", count: number }] — last 6 months
//   byScope: { academic: number, departmental: number }
//   streak: { current: number, longest: number } — consecutive months with >=1 scan
//
// This powers the attendance trends chart on the My Attendance page.
export async function GET(_req: NextRequest) {
  const res = await requireAuth("USER", { exactRole: true });
  if ("error" in res) return res.error;
  const { account } = res;

  // Single query: fetch ALL-TIME attendance with scannedAt + event.scope.
  // The previous implementation issued 3 separate findMany calls on the same
  // accountId (6-month chart, all-time scope counts, all-time streak months).
  // Collapsing to 1 query saves 2 DB round-trips per My-Attendance page load
  // and avoids transferring the same rows 3x. Buckets are derived in JS.
  const allAttendance = await db.eventAttendance.findMany({
    where: { accountId: account.id },
    select: { scannedAt: true, event: { select: { scope: true } } },
    orderBy: { scannedAt: "asc" },
  });

  // Build scansByMonth: 6 buckets (last 6 months only).
  const monthMap = new Map<string, number>();
  for (let i = 0; i < 6; i++) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    d.setHours(0, 0, 0, 0);
    monthMap.set(d.toISOString().slice(0, 7), 0);
  }
  for (const a of allAttendance) {
    const key = a.scannedAt.toISOString().slice(0, 7);
    if (monthMap.has(key)) monthMap.set(key, (monthMap.get(key) ?? 0) + 1);
  }
  const scansByMonth = Array.from(monthMap.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, count]) => ({ month, count }));

  // Build byScope (all time, from the same result set).
  const byScope = { academic: 0, departmental: 0 };
  for (const a of allAttendance) {
    if (a.event.scope === "academic") byScope.academic++;
    else if (a.event.scope === "departmental") byScope.departmental++;
  }

  // Compute streak (all time, from the same result set).
  const scanMonths = new Set(
    allAttendance.map((s) => s.scannedAt.toISOString().slice(0, 7)),
  );
  let currentStreak = 0;
  const now = new Date();
  for (let i = 0; i < 60; i++) {
    const d = new Date(now);
    d.setMonth(d.getMonth() - i);
    d.setDate(1);
    const key = d.toISOString().slice(0, 7);
    if (scanMonths.has(key)) currentStreak++;
    else if (i > 0) break; // break on first gap (not current month)
  }
  // Longest streak: scan all months from earliest to latest.
  let longestStreak = 0;
  let running = 0;
  const sortedMonths = Array.from(scanMonths).sort();
  let prevKey: string | null = null;
  for (const key of sortedMonths) {
    if (prevKey) {
      const [py, pm] = prevKey.split("-").map(Number);
      const [cy, cm] = key.split("-").map(Number);
      const expected = new Date(py, pm - 1, 1);
      expected.setMonth(expected.getMonth() + 1);
      const actual = new Date(cy, cm - 1, 1);
      if (
        expected.toISOString().slice(0, 7) === actual.toISOString().slice(0, 7)
      ) {
        running++;
      } else {
        running = 1;
      }
    } else {
      running = 1;
    }
    if (running > longestStreak) longestStreak = running;
    prevKey = key;
  }

  const response = NextResponse.json({
    scansByMonth,
    byScope,
    streak: { current: currentStreak, longest: longestStreak },
  });
  response.headers.set("Cache-Control", "private, no-cache");
  return response;
}
