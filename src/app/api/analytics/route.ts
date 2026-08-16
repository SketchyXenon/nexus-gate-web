import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api";
import { hashVisitorIp } from "@/lib/analytics-hash";

// ====================================================================
// POST /api/analytics/track
// --------------------------------------------------------------------
// Records a page view WITHOUT storing the raw IP. The public IP is
// HMAC-hashed (daily-rotating) so the row only identifies "same visitor
// on the same day" - never the IP itself. Aggregated upserts deduplicate
// on (dayBucket, visitorHash, route), keeping the table bounded.
//
// Per 06-security-architecture.md §8 (data minimization): no raw IP, no
// user agent fingerprint, no account binding. The endpoint is authed so
// an attacker can't flood it with fake rows beyond their rate limit.
// ====================================================================

export async function POST(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;

  let body: { route?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  // M3 fix: validate route shape before storing. Reject empty, too long,
  // non-path-prefixed, or control-character-bearing strings. This prevents
  // stored XSS in the admin analytics view (the route is rendered in the
  // admin dashboard). Cap at 255 to match the DB column (Visit.route).
  const rawRoute = typeof body.route === "string" ? body.route : "/";
  if (!rawRoute.startsWith("/") || rawRoute.length > 255) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  // Reject control chars (incl. <script>, newlines, NULs) - the route is
  // rendered in the admin view and must be safe to display.
  if (/[\x00-\x1f\x7f<>]/.test(rawRoute)) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const route = rawRoute;

  // Public IP (the edge proxy sets x-forwarded-for). This is NOT the
  // visitor's pure/private IP - it's the public routable address. We hash
  // it immediately and never persist the raw value.
  const forwarded = req.headers.get("x-forwarded-for");
  const publicIp = forwarded?.split(",")[0]?.trim() || null;
  const visitorHash = hashVisitorIp(publicIp);

  // Country (optional, country-level only - from Cloudflare's CF-IPCountry).
  const country = req.headers.get("cf-ipcountry") || null;

  const day = new Date().toISOString().slice(0, 10);

  try {
    // Upsert: increment the visit counter for this (day, visitor, route) trio.
    await db.visit.upsert({
      where: {
        dayBucket_visitorHash_route: {
          dayBucket: day,
          visitorHash,
          route,
        },
      },
      update: {
        visits: { increment: 1 },
        lastSeenAt: new Date(),
      },
      create: {
        dayBucket: day,
        visitorHash,
        route,
        country,
        visits: 1,
      },
    });
  } catch {
    // Non-critical: analytics must never break the user's page load.
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

// ====================================================================
// GET /api/analytics - admin dashboard summary (last 7 days)
// ====================================================================

export async function GET() {
  const res = await requireAuth("ADMIN");
  if ("error" in res) return res.error;

  try {
    const today = new Date();
    const days: string[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }

    // Total unique visitors + total visits per day for the last 7 days.
    const rows = await db.visit.groupBy({
      by: ["dayBucket"],
      where: { dayBucket: { in: days } },
      _count: { visitorHash: true },
      _sum: { visits: true },
    });

    const byDay = days.map((d) => {
      const r = rows.find((x) => x.dayBucket === d);
      return {
        day: d,
        uniqueVisitors: r?._count.visitorHash ?? 0,
        totalVisits: r?._sum.visits ?? 0,
      };
    });

    // Top routes by total visits (last 7 days).
    const topRoutes = await db.visit.groupBy({
      by: ["route"],
      where: { dayBucket: { in: days } },
      _sum: { visits: true },
      orderBy: { _sum: { visits: "desc" } },
      take: 5,
    });

    const totals = byDay.reduce(
      (acc, d) => ({
        uniqueVisitors: acc.uniqueVisitors + d.uniqueVisitors,
        totalVisits: acc.totalVisits + d.totalVisits,
      }),
      { uniqueVisitors: 0, totalVisits: 0 },
    );

    return NextResponse.json({
      days: byDay,
      topRoutes: topRoutes.map((r) => ({
        route: r.route,
        visits: r._sum.visits ?? 0,
      })),
      totals,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to load analytics." },
      { status: 500 },
    );
  }
}
