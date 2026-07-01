// Nexus Gate - Session Management (Supabase Auth).
// Single session system: Supabase Auth cookie. The old dual system
// (custom JWT + NextAuth) has been replaced - see supabase-session.ts.

import { db } from "@/lib/db";
import { getCurrentAccountSupabase, getSupabaseSession } from "@/lib/supabase-session";
import type { AccessTokenPayload } from "@/lib/auth";

// Read the current session from the Supabase Auth cookie.
export async function getSession(): Promise<AccessTokenPayload | null> {
  const supa = await getSupabaseSession();
  if (!supa) return null;
  const account = await db.account.findFirst({
    where: { supabaseAuthUid: supa.authUid },
    select: { id: true, role: true, status: true },
  });
  if (!account) return null;
  return { sub: account.id, role: account.role, status: account.status, type: "access" };
}

// Get the full account record for the current session.
// Always fetches fresh from DB so status changes (suspend) take effect
// immediately, not when the token expires.
export async function getCurrentAccount() {
  return getCurrentAccountSupabase();
}
