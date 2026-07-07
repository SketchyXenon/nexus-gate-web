import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Nexus Gate - Middleware: Supabase session refresh + security headers.
export async function proxy(request: NextRequest) {
  const response = NextResponse.next();

  // Refresh the Supabase Auth session, but only on routes that need auth.
  // Skipping public routes avoids a network call to Supabase on every request.
  const path = request.nextUrl.pathname;
  const isAuthRoute =
    path.startsWith("/api/auth/") ||
    path.startsWith("/api/accounts") ||
    path.startsWith("/api/profile") ||
    path.startsWith("/api/events") ||
    path.startsWith("/api/attendance") ||
    path.startsWith("/api/dashboard") ||
    path.startsWith("/api/notifications") ||
    path.startsWith("/api/whitelist") ||
    path.startsWith("/api/audit-logs") ||
    path.startsWith("/api/admin");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Skip if no Supabase config, not an auth route, or the request has no
  // session cookie (no point refreshing a session that doesn't exist).
  const hasSessionCookie =
    request.cookies.get("sb-access-token") ||
    request.cookies.get("__Secure-sb-access-token");
  if (supabaseUrl && supabaseKey && isAuthRoute && hasSessionCookie) {
    try {
      const supabase = createServerClient(supabaseUrl, supabaseKey, {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              request.cookies.set(name, value);
              response.cookies.set(name, value, options);
            });
          },
        },
      });
      await Promise.race([
        supabase.auth.getSession(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 1500),
        ),
      ]);
    } catch {
      // Supabase unreachable — skip session refresh, let the request proceed.
    }
  }

  // ---- CSRF Defense-in-Depth: Origin/Referer check for mutations ----
  // SameSite=Lax cookies are the primary CSRF defense. This Origin/Referer
  // check is a second layer.
  //
  // The rule is simple and robust:
  //   1. If Origin is present, it must be same-origin (match the request's
  //      Host or X-Forwarded-Host, port-insensitive) OR the configured
  //      NEXT_PUBLIC_APP_URL (production).
  //   2. If Origin is absent, check Referer the same way.
  //   3. If both are absent, allow (server-side or non-browser request).
  //
  // This always permits legitimate same-origin browser requests because the
  // browser's Origin always matches the Host it loaded the page from.
  //
  // IMPORTANT — port-insensitive comparison:
  //   When behind a gateway (Caddy on :81 → Next on :3000), the browser's
  //   Origin port (443/81) often differs from the Host port the server sees.
  //   We compare hostnames (without ports) to avoid false-positive CSRF
  //   blocks in dev/preview environments.
  //
  // IMPORTANT — X-Forwarded-Host:
  //   Reverse proxies (Caddy, nginx) add X-Forwarded-Host reflecting the
  //   ORIGINAL client Host. We trust this header (it's set by our own
  //   gateway, not user-controlled) so the preview-panel domain is
  //   recognized as same-origin.
  const method = request.method.toUpperCase();
  const isDev = process.env.NODE_ENV !== "production";

  // Skip CSRF check for cron endpoints — they're authenticated via
  // CRON_SECRET (Bearer/Basic/header/query), not session cookies.
  // cron-job.org and other third-party cron services send cross-origin
  // POSTs that would otherwise be blocked by the Origin/Referer check.
  const isCronRoute = path.startsWith("/api/cron/");

  if (["POST", "PATCH", "PUT", "DELETE"].includes(method) && !isCronRoute) {
    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");

    // Collect ALL host representations the request arrived with:
    //   - Host: the direct Host header (what the server socket sees)
    //   - X-Forwarded-Host: comma-separated chain of original client hosts
    //     (added by Caddy/nginx when proxying)
    const directHost = (request.headers.get("host") || "").toLowerCase();
    const forwardedHostRaw = (
      request.headers.get("x-forwarded-host") || ""
    ).toLowerCase();
    const forwardedHosts = forwardedHostRaw
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    const allHosts = [directHost, ...forwardedHosts].filter(Boolean);
    // Hostnames without ports — for port-insensitive comparison
    const allHostnames = allHosts.map((h) => h.split(":")[0]);

    // The configured production URL (host + hostname)
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    const appUrlHost = appUrl
      ? (() => {
          try {
            return new URL(appUrl).host.toLowerCase();
          } catch {
            return null;
          }
        })()
      : null;
    const appUrlHostname = appUrlHost ? appUrlHost.split(":")[0] : null;

    const isSameOrigin = (url: string): boolean => {
      try {
        const parsed = new URL(url);
        const originHost = parsed.host.toLowerCase(); // includes port
        const originHostname = parsed.hostname.toLowerCase(); // no port

        // 1. Exact host match (with port) against direct Host or any forwarded host
        if (allHosts.includes(originHost)) return true;

        // 2. Port-insensitive hostname match — handles gateway port differences
        //    (e.g. Origin https://sandbox.dev:443 vs Host sandbox.dev:81)
        if (allHostnames.includes(originHostname)) return true;

        // 3. Match the configured NEXT_PUBLIC_APP_URL (production canonical URL)
        if (
          appUrlHost &&
          (originHost === appUrlHost || originHostname === appUrlHostname)
        ) {
          return true;
        }

        // 4. Dev convenience: allow localhost / 127.0.0.1 on ANY port.
        //    (The previous code gated this on `!appUrlHost`, which was never
        //    true because NEXT_PUBLIC_APP_URL is always set — so the dev
        //    fallback was dead code. Now it keys off NODE_ENV instead.)
        if (
          isDev &&
          (originHostname === "localhost" || originHostname === "127.0.0.1")
        ) {
          return true;
        }

        // 5. Dev behind a trusted proxy: if X-Forwarded-Host is present we're
        //    behind our own gateway (preview panel, Caddy). In dev this is
        //    safe — SameSite=Lax cookies remain the primary CSRF defense.
        //    This unblocks preview-panel testing where the browser Origin
        //    is the sandbox domain but the internal Host is localhost:3000.
        if (isDev && forwardedHosts.length > 0) {
          return true;
        }

        return false;
      } catch {
        return false;
      }
    };

    // Primary check: if Origin is present, it must be same-origin.
    if (origin && !isSameOrigin(origin)) {
      return NextResponse.json(
        { error: "Cross-site requests are not allowed.", code: "CSRF_BLOCKED" },
        { status: 403 },
      );
    }
    // Fallback: if Origin is absent, check Referer.
    if (!origin && referer && !isSameOrigin(referer)) {
      return NextResponse.json(
        { error: "Cross-site requests are not allowed.", code: "CSRF_BLOCKED" },
        { status: 403 },
      );
    }
  }

  // Content Security Policy — prevents XSS, data injection
  // SECURITY (v8): Removed 'unsafe-eval' (not needed, weakens XSS protection).
  // connect-src: 'self' + the realtime service origin (if configured).
  //   The realtime service runs on a separate host (e.g. Render), so the
  //   browser needs both https:// (polling fallback) and wss:// (WebSocket)
  //   origins in connect-src. Without this, the CSP blocks the socket.io
  //   connection with "connect-src 'self' violates the following directive".
  // In dev: relax frame-ancestors so preview panels work.
  // In production: strict 'none' to prevent clickjacking.
  const cspFrameAncestors = isDev
    ? "frame-ancestors *"
    : "frame-ancestors 'none'";

  // Derive the realtime service origins from NEXT_PUBLIC_REALTIME_URL.
  // e.g. "https://nexus-gate-realtime.onrender.com"
  //   → ["https://nexus-gate-realtime.onrender.com", "wss://nexus-gate-realtime.onrender.com"]
  const realtimeUrl = process.env.NEXT_PUBLIC_REALTIME_URL;
  const realtimeOrigins: string[] = [];
  if (realtimeUrl) {
    try {
      const parsed = new URL(realtimeUrl);
      realtimeOrigins.push(`${parsed.protocol}//${parsed.host}`);
      // Also add the ws/wss variant (socket.io upgrades to WebSocket).
      const wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
      realtimeOrigins.push(`${wsProtocol}//${parsed.host}`);
    } catch {
      // Invalid URL — skip.
    }
  }
  const connectSrc = ["'self'", ...realtimeOrigins].join(" ");

  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://api.dicebear.com",
      `connect-src ${connectSrc}`,
      "frame-src 'self' https://challenges.cloudflare.com",
      cspFrameAncestors,
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  );

  // Prevent clickjacking — in dev allow same-origin framing (preview panels),
  // in production deny all framing.
  response.headers.set("X-Frame-Options", isDev ? "SAMEORIGIN" : "DENY");

  // Prevent MIME-type sniffing
  response.headers.set("X-Content-Type-Options", "nosniff");

  // Referrer policy — only send origin
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // HSTS — force HTTPS (1 year + preload).
  // Only meaningful over HTTPS; harmless on localhost HTTP dev.
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload",
  );

  // Permissions policy — disable unnecessary browser features
  response.headers.set(
    "Permissions-Policy",
    "camera=(self), microphone=(), geolocation=(), payment=()",
  );

  // XSS protection — set to 0 (modern browsers use CSP; old IE XSS Auditor was flawed)
  response.headers.set("X-XSS-Protection", "0");

  return response;
}

export const config = {
  matcher: [
    // Apply to all routes except static assets and service worker
    "/((?!_next/static|_next/image|favicon.ico|logo.svg|robots.txt|sw.js|manifest.json|icon-192.svg|icon-512.svg).*)",
  ],
};
