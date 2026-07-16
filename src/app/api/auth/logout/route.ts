import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { getCurrentAccountSupabase } from "@/lib/supabase-session";
import {
  createSupabaseServerClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";

// POST /api/auth/logout
// Signs out of Supabase Auth (clears the session cookie).
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
  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
