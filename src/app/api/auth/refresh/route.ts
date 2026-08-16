import { NextRequest, NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";
import { checkRateLimit } from "@/lib/api";
import { getSupabaseSession } from "@/lib/supabase-session";

// POST /api/auth/refresh
// Refreshes the Supabase session by calling supabase.auth.refreshSession().
// The @supabase/ssr client automatically sets the refreshed cookies via the
// cookies().setAll() callback. If the refresh fails (refresh token expired
// or revoked), returns 401 so the client redirects to login.
//
// SECURITY: a recovery (password-reset) session must NOT be refreshable
// into a long-lived session - otherwise an attacker who obtained a reset
// link could keep refreshing the recovery session indefinitely without
// ever setting a new password. We reject recovery sessions here.
export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Not configured" },
      { status: 503 },
    );
  }

  // Rate limit (per-IP, 30/min). Without this, an attacker can amplify DoS
  // against Supabase Auth by hammering this anonymous endpoint - each call
  // triggers a Supabase network round-trip.
  const rl = await checkRateLimit(req, "api");
  if (rl) return rl;

  // Reject recovery sessions: a password-reset session must not be refreshed
  // into a normal session. The user must set a new password (reset-password
  // route) which then signs out the recovery session.
  const session = await getSupabaseSession({ allowRecovery: true });
  if (session?.isRecovery) {
    return NextResponse.json(
      { ok: false, error: "Please set a new password to continue." },
      { status: 403 },
    );
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.refreshSession();

    if (error || !data.session) {
      return NextResponse.json(
        { ok: false, error: "Session expired" },
        { status: 401 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Refresh failed" },
      { status: 401 },
    );
  }
}
