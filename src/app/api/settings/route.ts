import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Cache the settings response for 30 seconds (reduces DB load on page loads).
export const revalidate = 30;

export async function GET() {
  try {
    const settings = await db.setting.findMany();
    const settingsMap: Record<string, string> = {};
    for (const s of settings) settingsMap[s.key] = s.value;
    const res = NextResponse.json({
      maintenanceMode: settingsMap.maintenance_mode === "true",
      maintenanceMessage:
        settingsMap.maintenance_message ||
        "The system is under maintenance. Please check back later.",
    });
    res.headers.set(
      "Cache-Control",
      "public, s-maxage=30, stale-while-revalidate=60",
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
