import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const timestamp = new Date().toISOString();
  const checks: Record<string, string> = {};
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("DB timeout")), 3000),
      ),
    ]);
    checks.database = "ok";
  } catch (e) {
    checks.database = "down";
    // Classify the error so the operator knows WHERE to look:
    //   - auth failure  → DATABASE_URL password is wrong (or has unencoded
    //                     special chars) — fix the env var on Vercel.
    //   - unreachable   → wrong host/port, or network/firewall issue.
    //   - timeout       → DB is overloaded or the connection string points
    //                     to the wrong place.
    const errName = e instanceof Error ? e.name : "Unknown";
    const errMsg = e instanceof Error ? e.message : "DB failed";
    let hint = "Check DATABASE_URL and database server status.";
    if (errName === "PrismaClientInitializationError") {
      if (
        errMsg.includes("Authentication failed") ||
        errMsg.includes("credentials")
      ) {
        hint =
          "DB authentication failed — DATABASE_URL password is wrong or contains special characters that need URL-encoding (e.g. @ → %40, : → %3A, / → %2F, # → %23).";
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
        database: checks.database,
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
