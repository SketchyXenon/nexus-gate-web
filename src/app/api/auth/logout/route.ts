import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { getCurrentAccountSupabase } from "@/lib/supabase-session";
import { createSupabaseServerClient } from "@/lib/supabase-server";

// POST /api/auth/logout
// Signs out of Supabase Auth (clears the single session cookie).
export async function POST(req: NextRequest) {
  const account = await getCurrentAccountSupabase().catch(() => null);
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  if (account) {
    await audit({
      actorId: account.id,
      action: "auth.logout",
      targetType: "Account",
      targetId: account.id,
      req,
    }).catch(() => {});
  }
  return Response.json({ ok: true });
}
