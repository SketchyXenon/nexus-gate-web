// Nexus Gate - Supabase server client (cookie-based sessions).
// Used in API routes and Server Components to read the auth session.
// server-only guard: prevents accidental import in client components,
// which would bundle the SUPABASE_SERVICE_ROLE_KEY.

import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// ====================================================================
// Session persistence ("Remember me")
// --------------------------------------------------------------------
// @supabase/ssr v0.12 defaults its session cookies to maxAge = 400 DAYS
// and httpOnly = FALSE (see its DEFAULT_COOKIE_OPTIONS). That means every
// session is effectively a 400-day remember-me with tokens readable by
// JavaScript. This adapter replaces that with an explicit, sticky policy:
//
//   Remember me CHECKED  -> session cookies persist for 30 days
//                           (marker cookie ng_sess=p, maxAge 30d)
//   Remember me UNCHECKED -> session cookies are browser-session cookies
//                           (no maxAge - cleared when the browser closes)
//
// The marker cookie makes the choice STICKY: on every later token refresh
// (any API route calling getSession/getUser/refreshSession re-writes the
// cookies through this adapter) the same persistence is re-applied, so a
// refresh can never silently upgrade a session-scoped cookie to 30 days.
//
// Security properties:
//   - HttpOnly ALWAYS (XSS cannot read the access/refresh tokens; the app
//     has no browser-side Supabase client that needs cookie access).
//   - Secure in production (HTTPS-only transport).
//   - SameSite=Lax (CSRF defense-in-depth on top of proxy.ts Origin check).
//   - The 30-minute inactivity auto-logout (use-session-timeout.ts) applies
//     REGARDLESS of remember-me: persistence survives browser restarts,
//     never idleness. Remember me is also force-disabled for ADMIN accounts
//     (login route) - privileged sessions stay browser-scoped.
// ====================================================================

/** Max session lifetime when "Remember me" is checked (30 days). */
export const REMEMBER_MAX_AGE_S = 30 * 24 * 60 * 60;

/** Marker cookie recording that this browser chose a remembered session. */
export const SESSION_MARKER_COOKIE = "ng_sess";

// Check that Supabase env vars are configured. Returns false if missing.
export function isSupabaseConfigured(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

// Check that the Supabase ADMIN (service-role) credentials are configured.
// The service-role key is REQUIRED for admin operations
// (admin.deleteUser, admin.updateUserById, admin.listUsers) that bypass RLS.
// isSupabaseConfigured() alone is NOT sufficient for these operations —
// without SUPABASE_SERVICE_ROLE_KEY, createSupabaseAdminClient() constructs a
// client with an undefined key and every admin call fails (caught + swallowed
// by the caller, historically producing silent orphans in auth.users).
// Routes that perform admin mutations MUST gate on THIS check, not just
// isSupabaseConfigured(), so they can either fail closed or surface a clear
// "service key not configured" reason instead of a silent failure.
export function isSupabaseAdminConfigured(): boolean {
  return isSupabaseConfigured() && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

export async function createSupabaseServerClient(opts?: {
  /**
   * Explicit persistence override. The login route passes the user's
   * checkbox choice here (the marker cookie doesn't exist yet at sign-in
   * time). All other callers omit it and inherit the sticky marker value.
   */
  rememberSession?: boolean;
}) {
  const cookieStore = await cookies();

  // Sticky persistence: explicit override wins, else read the marker.
  const remembered =
    opts?.rememberSession ??
    cookieStore.get(SESSION_MARKER_COOKIE)?.value === "p";

  const secure = process.env.NODE_ENV === "production";

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
            cookiesToSet.forEach(({ name, value, options }) => {
              const o = {
                path: "/",
                ...options,
                httpOnly: true,
                sameSite: "lax" as const,
                secure,
              };
              // Only REAL value sets carry a positive maxAge (Supabase
              // sends maxAge 0 for deletions - those must pass through so
              // signOut still clears the cookies).
              if (options?.maxAge && options.maxAge > 0) {
                if (remembered) {
                  // Remembered: bounded 30-day persistence (NOT Supabase's
                  // 400-day default).
                  o.maxAge = REMEMBER_MAX_AGE_S;
                } else {
                  // Not remembered: browser-session cookie (no maxAge).
                  delete o.maxAge;
                }
              }
              cookieStore.set(name, value, o);
            });
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
