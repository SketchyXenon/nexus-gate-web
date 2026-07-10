// Nexus Gate - Supabase browser client (cookie-based sessions).
// Used in Client Components for sign-in, sign-out, OAuth redirects.
//
// Module-scope singleton: creating a Supabase client is expensive (auth
// init, WebSocket setup). Reuse one instance across all calls.

import { createBrowserClient } from "@supabase/ssr";

let browserClient: ReturnType<typeof createBrowserClient> | null = null;

export function createSupabaseBrowserClient() {
  if (!browserClient) {
    browserClient = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }
  return browserClient;
}
