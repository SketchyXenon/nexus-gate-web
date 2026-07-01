import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/health
// Diagnoses DB connectivity AND query execution. The raw `SELECT 1` tests
// basic connectivity, while `db.setting.count()` runs a real model query
// (which uses prepared statements) — this catches the Supabase pooler
// (Supavisor/PgBouncer) prepared-statement conflict (PostgreSQL 42P05)
// that a raw query would miss.
export async function GET() {
  const timestamp = new Date().toISOString();
  const checks: Record<string, string> = {};

  // ---- 1. Connectivity test (raw query) ----
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("DB timeout")), 3000),
      ),
    ]);
    checks.connectivity = "ok";
  } catch (e) {
    checks.connectivity = "down";
    const errName = e instanceof Error ? e.name : "Unknown";
    const errMsg = e instanceof Error ? e.message : "DB failed";
    let hint = "Check DATABASE_URL and database server status.";
    if (errName === "PrismaClientInitializationError") {
      if (
        errMsg.includes("Authentication failed") ||
        errMsg.includes("credentials")
      ) {
        hint =
          "DB authentication failed — DATABASE_URL password is wrong or contains special characters that need URL-encoding (e.g. @ -> %40, : -> %3A, / -> %2F, # -> %23).";
      } else if (errMsg.includes("timed out") || errMsg.includes("timeout")) {
        hint =
          "DB connection timed out — check that the DATABASE_URL host/port is reachable from Vercel.";
      } else {
        hint =
          "DB initialization failed — check that DATABASE_URL is set correctly on Vercel and points to a reachable Postgres instance.";
      }
    }
    return NextResponse.json(
      {
        status: "degraded",
        service: "nexus-gate",
        version: "3.0.0",
        database: "down",
        errorType: errName,
        hint,
        checks,
        timestamp,
      },
      { status: 503 },
    );
  }

  // ---- 2. Model query test (uses prepared statements) ----
  // This catches the PgBouncer/Supavisor pooler conflict (42P05) that
  // a raw SELECT 1 would miss. If this fails with "prepared statement
  // already exists", the operator needs to add ?pgbouncer=true to
  // DATABASE_URL on Vercel.
  try {
    await db.setting.count();
    checks.query = "ok";
  } catch (e) {
    checks.query = "down";
    const errName = e instanceof Error ? e.name : "Unknown";
    const errMsg = e instanceof Error ? e.message : "Query failed";
    let hint = "DB query failed unexpectedly.";
    if (
      errMsg.includes("42P05") ||
      (errMsg.includes("prepared statement") &&
        errMsg.includes("already exists"))
    ) {
      hint =
        "PgBouncer/Supavisor pooler conflict detected. Add ?pgbouncer=true&connection_limit=1 to your DATABASE_URL on Vercel (Settings -> Environment Variables -> DATABASE_URL). This tells Prisma to use simple queries instead of prepared statements, which are incompatible with Supabase's transaction-mode connection pooler.";
    }
    return NextResponse.json(
      {
        status: "degraded",
        service: "nexus-gate",
        version: "3.0.0",
        database: "pooler_conflict",
        errorType: errName,
        hint,
        checks,
        timestamp,
      },
      { status: 503 },
    );
  }

  return NextResponse.json({
    status: "ok",
    service: "nexus-gate",
    version: "3.0.0",
    timestamp,
    checks,
    uptime: process.uptime(),
  });
}
