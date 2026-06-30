import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const timestamp = new Date().toISOString();
  const checks: Record<string, string> = {};
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error("DB timeout")), 3000)),
    ]);
    checks.database = "ok";
  } catch (e) {
    checks.database = "down";
    return NextResponse.json(
      { status: "degraded", service: "nexus-gate", version: "3.0.0", error: e instanceof Error ? e.message : "DB failed", checks, timestamp },
      { status: 503 }
    );
  }
  return NextResponse.json({ status: "ok", service: "nexus-gate", version: "3.0.0", timestamp, checks, uptime: process.uptime() });
}
