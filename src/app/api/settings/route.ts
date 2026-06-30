import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  try {
    const settings = await db.setting.findMany();
    const settingsMap: Record<string, string> = {};
    for (const s of settings) settingsMap[s.key] = s.value;
    return NextResponse.json({
      maintenanceMode: settingsMap.maintenance_mode === "true",
      maintenanceMessage: settingsMap.maintenance_message || "The system is under maintenance. Please check back later.",
    });
  } catch {
    // If the database isn't connected (e.g. missing DATABASE_URL on Vercel),
    // return defaults instead of crashing the page.
    return NextResponse.json({
      maintenanceMode: false,
      maintenanceMessage: "The system is under maintenance. Please check back later.",
    });
  }
}
