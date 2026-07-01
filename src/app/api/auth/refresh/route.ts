import { NextResponse } from "next/server";

// POST /api/auth/refresh
// With Supabase Auth, session refresh is handled automatically by the
// middleware (proxy.ts calls supabase.auth.getSession() on every request).
// This endpoint is kept as a no-op for backward compatibility with the
// client's auto-refresh-on-401 logic. It returns 200 so the client
// retries the original request (which will now have a refreshed cookie).
export async function POST() {
  return NextResponse.json({ ok: true });
}
