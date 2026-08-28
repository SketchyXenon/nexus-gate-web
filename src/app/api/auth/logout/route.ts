import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { getCurrentAccountSupabase } from "@/lib/supabase-session";
import {
  createSupabaseServerClient,
  isSupabaseConfigured,
  SESSION_MARKER_COOKIE,
} from "@/lib/supabase-server";
import { MFA_CHALLENGE_COOKIE, MFA_VERIFIED_COOKIE } from "@/lib/mfa";

// POST /api/auth/logout
// Signs out of Supabase Auth (clears the session cookie) and removes the
// "Remember me" persistence marker so a subsequent session-scoped login
// on the same browser can never inherit the previous 30-day persistence.
// Also clears the MFA cookies: a lingering ng_mfa_verified (30d when
// remembered) would mark the browser as MFA-verified for the NEXT login
// on a shared machine - the next sign-in must re-challenge with TOTP.
export async function POST(req: NextRequest) {
  const account = await getCurrentAccountSupabase().catch(() => null);
  if (isSupabaseConfigured()) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut().catch(() => {});
  }
  if (account) {
    await audit({
      actorId: account.id,
      action: "auth.logout",
      targetType: "Account",
      targetId: account.id,
      req,
    }).catch(() => {});
  }
  const response = NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
  // Explicit sign-out revokes the choice to stay signed in.
  response.cookies.delete(SESSION_MARKER_COOKIE);
  // Clear the MFA marker + any pending challenge + remember intent.
  response.cookies.delete(MFA_VERIFIED_COOKIE);
  response.cookies.delete(MFA_CHALLENGE_COOKIE);
  response.cookies.delete("ng_mfa_remember");
  return response;
}
