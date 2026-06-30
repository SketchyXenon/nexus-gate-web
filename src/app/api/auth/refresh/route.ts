import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookies, rotateRefreshToken } from "@/lib/session";
import { parseBody, unauthorized, getClientIp } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";

// POST /api/auth/refresh — rotate refresh token, issue new session
// Rate limited: max 10 per IP per minute (prevents brute-force token guessing)
export async function POST(req: NextRequest) {
  // ---- Rate limit ----
  const ip = getClientIp(req);
  const rl = await rateLimit(`refresh:ip:${ip}`, "api");
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many refresh attempts. Please slow down.", code: "RATE_LIMITED" },
      { status: 429 }
    );
  }

  const body = await parseBody<{ refreshToken?: string }>(req);
  let refreshToken = body?.refreshToken;

  // Fall back to cookie if not in body
  if (!refreshToken) {
    const cookieHeader = req.headers.get("cookie") || "";
    const match = cookieHeader.match(/ng_refresh=([^;]+)/);
    if (match) refreshToken = match[1];
  }

  if (!refreshToken) return unauthorized("No refresh token");

  const result = await rotateRefreshToken(refreshToken);
  if (!result.ok) {
    await clearSessionCookies();
    return unauthorized("Your session has expired. Please sign in again.");
  }
  return Response.json({ ok: true, accountId: result.accountId, role: result.role });
}
