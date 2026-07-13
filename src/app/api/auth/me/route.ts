import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";

// ====================================================================
// GET /api/auth/me
// Returns the current authenticated user's profile.
//
// Uses requireAuth() which enforces per-account rate limiting, maintenance
// mode, and active status. The account object from requireAuth() already
// contains all fields the client needs (id, email, fullName, role, status,
// studentId, program, section, lastLoginAt) — no second DB query needed.
// ====================================================================
export async function GET() {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  return NextResponse.json(
    account,
    { headers: { "Cache-Control": "private, no-cache" } },
  );
}
