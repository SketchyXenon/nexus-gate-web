// Nexus Gate - Supabase Auth session layer.
// Replaces the old dual system (custom JWT + NextAuth) with one
// Supabase Auth session. Reads the session cookie via @supabase/ssr,
// resolves the Supabase user, then loads the linked accounts row.

import {
  createSupabaseServerClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";
import { db } from "@/lib/db";
import type { ApiAccount } from "@/lib/api";

export interface SupabaseSession {
  authUid: string;
  email: string;
}

// Read the Supabase session from cookies. Returns null if no session
// or if Supabase isn't configured (dev without env vars).
export async function getSupabaseSession(): Promise<SupabaseSession | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { authUid: data.user.id, email: data.user.email ?? "" };
}

// Resolve the current account from the Supabase session.
// Always fetches fresh from DB so status changes (suspend) take effect
// immediately, not when the token expires.
export async function getCurrentAccountSupabase(): Promise<ApiAccount | null> {
  const session = await getSupabaseSession();
  if (!session) return null;

  const account = await db.account.findFirst({
    where: { supabaseAuthUid: session.authUid },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      status: true,
      studentId: true,
      program: true,
      section: true,
      organizationName: true,
      year: true,
    },
  });

  if (!account || account.status !== "ACTIVE") return null;
  return { ...account, role: account.role as ApiAccount["role"] };
}
