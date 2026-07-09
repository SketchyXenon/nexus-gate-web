import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkCronAuth, checkBodySecret } from "@/lib/cron-auth";

// /api/cron/cleanup
// Removes expired tokens + old notifications.
// Auth: Bearer header, Basic auth (cron-job.org password), custom header,
//       query param, or JSON body field. See src/lib/cron-auth.ts.

async function runCleanup() {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [tokensDeleted, refreshDeleted, oldNotifications] = await Promise.all([
    db.verificationToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
    }),
    db.refreshToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }] },
    }),
    db.notification.deleteMany({
      where: { readAt: { lt: thirtyDaysAgo } },
    }),
  ]);

  return {
    deleted: {
      verificationTokens: tokensDeleted.count,
      refreshTokens: refreshDeleted.count,
      oldNotifications: oldNotifications.count,
    },
    timestamp: now.toISOString(),
  };
}

function authorizeCron(req: NextRequest): NextResponse | null {
  const result = checkCronAuth(req);
  if (result.ok) return null;
  const cronSecretSet = Boolean((process.env.CRON_SECRET || "").trim());
  console.warn(
    `[cron/cleanup] auth failed: ${result.reason}` +
      (result.method ? ` (method: ${result.method})` : "") +
      ` | CRON_SECRET set: ${cronSecretSet}`,
  );
  return NextResponse.json(
    {
      error: "Unauthorized",
      code: "CRON_UNAUTHORIZED",
      hint: cronSecretSet
        ? "Auth methods: Bearer token, Basic auth, x-cron-secret header, ?secret= query param, or JSON body."
        : "CRON_SECRET env var is not set on the server.",
    },
    { status: 401 },
  );
}

export async function GET(req: NextRequest) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  const result = await runCleanup();
  return NextResponse.json(
    { ok: true, ...result },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  // Try header/query auth first.
  const headerResult = checkCronAuth(req);
  if (!headerResult.ok) {
    // Fallback: try reading secret from JSON body.
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        const body = await req.json();
        if (checkBodySecret(body)) {
          const result = await runCleanup();
          return NextResponse.json({ ok: true, ...result });
        }
      } catch {
        // Empty/invalid JSON — fall through to 401.
      }
    }
    return authorizeCron(req) ?? NextResponse.json({ ok: true });
  }

  const result = await runCleanup();
  return NextResponse.json({ ok: true, ...result });
}
