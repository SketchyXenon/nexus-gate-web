import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getApiAccount } from "@/lib/api";

export const dynamic = "force-dynamic";

// GET /api/health
// Public: returns only {status: "ok"|"degraded"}. Diagnostics (DB error
// type, hints, uptime) are gated behind admin auth to avoid leaking
// architecture details (DB type, provider, error codes) to attackers.
export async function GET() {
  const timestamp = new Date().toISOString();
  const checks: Record<string, string> = {};

  // Stage 1: connectivity (raw query).
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error("DB timeout")), 3000)),
    ]);
    checks.connectivity = "ok";
  } catch {
    checks.connectivity = "down";
    return NextResponse.json(
      { status: "degraded", timestamp },
      { status: 503 }
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
      { status: 503 }
    );
  }

  // Public response: minimal info.
  const account = await getApiAccount().catch(() => null);
  if (account && account.role === "ADMIN") {
    // Admins get full diagnostics for troubleshooting.
    return NextResponse.json({
      status: "ok",
      timestamp,
      checks,
      uptime: process.uptime(),
    }, { headers: { "Cache-Control": "private, no-cache" } });
  }

  return NextResponse.json(
    { status: "ok", timestamp },
    { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" } },
  );
}
