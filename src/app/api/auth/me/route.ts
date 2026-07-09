import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api";

// ====================================================================
// GET /api/auth/me
// Returns the current authenticated user's profile.
//
// SECURITY (pentest DOS-04): Previously used getApiAccount() which
// bypasses per-account rate limiting and maintenance-mode checks.
// Now uses requireAuth() which enforces:
//   - Per-account rate limit (100 req/min)
//   - Maintenance mode (non-admins blocked)
//   - Active status check (suspended accounts rejected)
// ====================================================================
export async function GET() {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account: user } = res;

  const account = await db.account.findUnique({
    where: { id: user.id },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      status: true,
      studentId: true,
      program: true,
      section: true,
      lastLoginAt: true,
    },
  });
  if (!account)
    return NextResponse.json(
      { error: "Unauthorized", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  return NextResponse.json(account, {
    headers: { "Cache-Control": "private, no-cache" },
  });
}
