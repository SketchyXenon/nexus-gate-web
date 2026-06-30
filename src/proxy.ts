import { NextResponse, type NextRequest } from "next/server";

// ====================================================================
// Nexus Gate — Security Headers Middleware (OWASP)
// Sets CSP, X-Frame-Options, X-Content-Type-Options, HSTS, and more.
// ====================================================================

export function proxy(request: NextRequest) {
  const response = NextResponse.next();

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
  if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");

    // Collect ALL host representations the request arrived with:
    //   - Host: the direct Host header (what the server socket sees)
    //   - X-Forwarded-Host: comma-separated chain of original client hosts
    //     (added by Caddy/nginx when proxying)
    const directHost = (request.headers.get("host") || "").toLowerCase();
    const forwardedHostRaw = (request.headers.get("x-forwarded-host") || "").toLowerCase();
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
      ? (() => { try { return new URL(appUrl).host.toLowerCase(); } catch { return null; } })()
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
        if (appUrlHost && (originHost === appUrlHost || originHostname === appUrlHostname)) {
          return true;
        }

        // 4. Dev convenience: allow localhost / 127.0.0.1 on ANY port.
        //    (The previous code gated this on `!appUrlHost`, which was never
        //    true because NEXT_PUBLIC_APP_URL is always set — so the dev
        //    fallback was dead code. Now it keys off NODE_ENV instead.)
        if (isDev && (originHostname === "localhost" || originHostname === "127.0.0.1")) {
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
        { status: 403 }
      );
    }
    // Fallback: if Origin is absent, check Referer.
    if (!origin && referer && !isSameOrigin(referer)) {
      return NextResponse.json(
        { error: "Cross-site requests are not allowed.", code: "CSRF_BLOCKED" },
        { status: 403 }
      );
    }
  }

  // Content Security Policy — prevents XSS, data injection
  // SECURITY (v8): Removed 'unsafe-eval' (not needed, weakens XSS protection).
  // Restricted connect-src to 'self' only (was ws: wss: which allowed any WS origin).
  // In dev: relax frame-ancestors so preview panels work.
  // In production: strict 'none' to prevent clickjacking.
  const cspFrameAncestors = isDev ? "frame-ancestors *" : "frame-ancestors 'none'";
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://api.dicebear.com",
      "connect-src 'self'",
      "frame-src 'self' https://challenges.cloudflare.com",
      cspFrameAncestors,
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ")
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
    "max-age=31536000; includeSubDomains; preload"
  );

  // Permissions policy — disable unnecessary browser features
  response.headers.set(
    "Permissions-Policy",
    "camera=(self), microphone=(), geolocation=(), payment=()"
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
