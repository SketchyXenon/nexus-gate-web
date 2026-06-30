import { NextRequest } from "next/server";
import { clearSessionCookies } from "@/lib/session";
import { requireAuth } from "@/lib/api";
import { audit } from "@/lib/audit";

// POST /api/auth/logout
export async function POST(req: NextRequest) {
  const res = await requireAuth();
  // Logout should work even if the session is expired — don't return early on error.
  const account = "account" in res ? res.account : null;
  await clearSessionCookies();
  if (account) {
    await audit({
      actorId: account.id,
      action: "auth.logout",
      targetType: "Account",
      targetId: account.id,
      req,
    });
  }
  return Response.json({ ok: true });
}
