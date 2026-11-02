import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth, checkBodySecret } from "@/lib/cron-auth";
import { runKeepAlive } from "@/lib/keep-alive";

export const dynamic = "force-dynamic";

// ====================================================================
// GET|POST /api/cron/keep-alive
// --------------------------------------------------------------------
// Standalone trigger for the dependency keep-alive watchdog
// (docs/supabase-keep-alive.md). Pings Supabase Auth's /auth/v1/health
// (counts as API activity and resets the free-tier ~7-day pause timer)
// and the app database, persists watchdog state, and emails admins on
// failure/recovery via SMTP.
//
// REDUNDANCY: the same watchdog also runs embedded in the daily
// /api/cron/cleanup run (Vercel Hobby caps cron jobs at 2 - both slots
// are used). This endpoint exists for EXTERNAL schedulers (cron-job.org,
// EasyCron) so a second, Vercel-independent trigger keeps the Supabase
// project active. Either trigger alone is sufficient.
//
// Auth: Bearer header, Basic auth (cron-job.org "Password" field),
//       x-cron-secret header, or JSON body {"secret": "..."}. Checks
//       CRON_KEEPALIVE_SECRET first, then CRON_SECRET. Fail-closed.
//
// Responses: 200 healthy/skipped, 503 when a check failed - the 503
// lets external uptime monitors escalate independently.
// ====================================================================

function authorize(req: NextRequest): NextResponse | null {
  const result = checkCronAuth(req, "keepalive");
  if (result.ok) return null;
  const cronSecretSet = Boolean((process.env.CRON_SECRET || "").trim());
  console.warn(
    `[cron/keep-alive] auth failed: ${result.reason}` +
      (result.method ? ` (method: ${result.method})` : "") +
      ` | CRON_SECRET set: ${cronSecretSet}`,
  );
  return NextResponse.json(
    {
      error: "Unauthorized",
      code: "CRON_UNAUTHORIZED",
      hint: cronSecretSet
        ? "Auth methods: Bearer token, Basic auth, x-cron-secret header, or JSON body."
        : "CRON_SECRET env var is not set on the server.",
    },
    { status: 401 },
  );
}

async function run(): Promise<NextResponse> {
  // runKeepAlive is designed to never throw; a watchdog that crashes
  // would be worse than useless.
  const summary = await runKeepAlive();
  const healthy = summary.status !== "fail";
  return NextResponse.json(
    { ok: healthy, ...summary },
    {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export async function GET(req: NextRequest) {
  const denied = authorize(req);
  if (denied) return denied;
  return run();
}

export async function POST(req: NextRequest) {
  // Try header/query auth first.
  const headerResult = checkCronAuth(req, "keepalive");
  if (!headerResult.ok) {
    // Fallback: try reading the secret from a JSON body field.
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        const body = await req.json();
        if (checkBodySecret(body, "keepalive")) return run();
      } catch {
        // Empty/invalid JSON - fall through to 401.
      }
    }
    const denied = authorize(req);
    if (denied) return denied;
  }
  return run();
}
