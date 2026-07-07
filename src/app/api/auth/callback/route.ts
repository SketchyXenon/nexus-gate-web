import { NextRequest, NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";

// ====================================================================
// GET /api/auth/callback?code=<pkce_code>&type=<magiclink|recovery|...>
// --------------------------------------------------------------------
// Server-side PKCE code exchange for Supabase Auth email redirects.
//
// WHY THIS EXISTS:
//   signInWithOtp() and resetPasswordForEmail() are called SERVER-side
//   (in magic-link/route.ts and forgot-password/route.ts). With PKCE
//   flow (Supabase v2 default), this generates a code_verifier stored
//   in an httpOnly cookie. The browser client (createBrowserClient)
//   CANNOT read httpOnly cookies via document.cookie, so calling
//   exchangeCodeForSession() client-side fails with "code_verifier
//   mismatch" — which surfaces to the user as "link expired."
//
//   This route runs on the SERVER, where cookieStore.getAll() CAN read
//   the httpOnly code_verifier cookie. It exchanges the code, sets the
//   session cookies via Set-Cookie headers, and returns the type so the
//   client knows whether to show the reset form (recovery) or reload
//   (magiclink/signup).
// ====================================================================

export async function GET(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      {
        error: "Authentication is not configured.",
        code: "AUTH_NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }

  const code = req.nextUrl.searchParams.get("code");
  const type = req.nextUrl.searchParams.get("type");

  if (!code) {
    return NextResponse.json(
      { error: "Missing authorization code.", code: "MISSING_CODE" },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error(
      "[auth/callback] exchangeCodeForSession failed:",
      error.message,
    );
    return NextResponse.json(
      { error: error.message, code: "EXCHANGE_FAILED" },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true, type: type || "magiclink" });
}
