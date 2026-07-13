// Nexus Gate - Supabase server client (cookie-based sessions).
// Used in API routes and Server Components to read the auth session.
// server-only guard: prevents accidental import in client components,
// which would bundle the SUPABASE_SERVICE_ROLE_KEY.

import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Check that Supabase env vars are configured. Returns false if missing.
export function isSupabaseConfigured(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component where cookies can't be set.
            // Safe to ignore - the middleware will refresh the session.
          }
        },
      },
    },
  );
}

// Admin client bypasses RLS. Only for trusted server operations
// (bulk account creation, user lookup by ID). NEVER expose to the client.
import { createClient } from "@supabase/supabase-js";

export function createSupabaseAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
