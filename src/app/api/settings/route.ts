import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Cache the settings response for 30 seconds (reduces DB load on page loads).
export const revalidate = 30;

// ALLOWLIST of public settings keys safe to expose on the unauthenticated
// landing page. Adding a key here makes it public; anything NOT in this list
// is filtered out (M2 fix: previously findMany() returned ALL rows, which
// could leak future sensitive admin-only settings added to the table).
const PUBLIC_KEYS = new Set(["maintenance_mode", "maintenance_message"]);

export async function GET() {
  try {
    // Fetch only the public-allowed keys (defense-in-depth: even if a
    // sensitive setting is added later, it won't leak here).
    const settings = await db.setting.findMany({
      where: { key: { in: Array.from(PUBLIC_KEYS) } },
    });
    const settingsMap: Record<string, string> = {};
    for (const s of settings) settingsMap[s.key] = s.value;
    const res = NextResponse.json({
      maintenanceMode: settingsMap.maintenance_mode === "true",
      maintenanceMessage:
        settingsMap.maintenance_message ||
        "The system is under maintenance. Please check back later.",
    });
    // private (not public) cache: the maintenance state is per-deploy,
    // but we don't want shared CDN caches to serve a stale maintenance flag
    // to a different tenant. s-maxage keeps the browser cache short.
    res.headers.set(
      "Cache-Control",
      "private, max-age=10, stale-while-revalidate=30",
    );
    return res;
  } catch {
    return NextResponse.json({
      maintenanceMode: false,
      maintenanceMessage:
        "The system is under maintenance. Please check back later.",
    });
  }
}
