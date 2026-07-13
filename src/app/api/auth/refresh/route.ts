import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";

// POST /api/auth/refresh
// Refreshes the Supabase session by calling supabase.auth.refreshSession().
// The @supabase/ssr client automatically sets the refreshed cookies via the
// cookies().setAll() callback. If the refresh fails (refresh token expired
// or revoked), returns 401 so the client redirects to login.
export async function POST() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Not configured" },
      { status: 503 },
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
