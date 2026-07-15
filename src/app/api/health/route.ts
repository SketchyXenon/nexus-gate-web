import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getApiAccount } from "@/lib/api";

export const dynamic = "force-dynamic";

// GET /api/health
// Public: returns only {status: "ok"|"degraded"}. Diagnostics (DB error
// type, hints, uptime, Ably status) are gated behind admin auth to avoid
// leaking architecture details to attackers.
export async function GET() {
  const timestamp = new Date().toISOString();
  const checks: Record<string, string> = {};

  // Stage 1: DB connectivity (raw query).
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("DB timeout")), 3000),
      ),
    ]);
    checks.connectivity = "ok";
  } catch {
    checks.connectivity = "down";
    return NextResponse.json(
      { status: "degraded", timestamp },
      { status: 503 },
    );
  }

  // Stage 2: model query (catches prepared-statement pooler conflicts).
  try {
    await db.setting.count();
    checks.query = "ok";
  } catch {
    checks.query = "down";
    return NextResponse.json(
      { status: "degraded", timestamp },
      { status: 503 },
    );
  }

  // Stage 3: Ably realtime reachability (non-blocking for status — a down
  // Ably degrades realtime but doesn't break attendance recording).
  const serverKey = process.env.ABLY_SERVER_KEY;
  if (!serverKey) {
    checks.ably = "not_configured";
  } else {
    try {
      const ablyRes = await Promise.race([
        fetch("https://rest.ably.io/time", {
          signal: AbortSignal.timeout(2000),
        }),
        new Promise<Response>((_, reject) =>
          setTimeout(() => reject(new Error("Ably timeout")), 2500),
        ),
      ]);
      checks.ably = ablyRes.ok ? "ok" : "degraded";
    } catch {
      checks.ably = "down";
    }
  }

  // Public response: minimal info.
  const account = await getApiAccount().catch(() => null);
  if (account && account.role === "ADMIN") {
    // Admins get full diagnostics for troubleshooting.
    return NextResponse.json(
      {
        status: "ok",
        timestamp,
        checks,
        uptime: process.uptime(),
      },
      { headers: { "Cache-Control": "private, no-cache" } },
    );
  }

  return NextResponse.json(
    { status: "ok", timestamp },
    {
      headers: {
        "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
      },
    },
  );
}
