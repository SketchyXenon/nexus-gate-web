import type { NextRequest } from "next/server";

// Derive the WebAuthn RP ID and expected origin from the PUBLIC origin the
// browser used, not the internal origin Next.js sees behind a proxy.
// Priority: NEXT_PUBLIC_APP_URL > forwarded Host/proto headers > req.nextUrl.
// This is critical: a credential registered on the public domain will NOT
// verify if the server computes rpID from req.nextUrl.hostname (which is
// localhost behind Caddy/Vercel).
function resolvePublicOrigin(req: NextRequest): URL {
  // 1. Canonical production URL.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (appUrl) {
    try {
      return new URL(appUrl);
    } catch {
      // fall through
    }
  }

  // 2. Forwarded Host + Proto (set by Caddy/nginx/Vercel).
  const forwardedHost = req.headers.get("x-forwarded-host");
  const forwardedProto = req.headers.get("x-forwarded-proto") || "https";
  if (forwardedHost) {
    const host = forwardedHost.split(",")[0]?.trim();
    if (host) {
      try {
        return new URL(`${forwardedProto}://${host}`);
      } catch {
        // fall through
      }
    }
  }

  // 3. Direct Host header (includes port if non-default).
  const directHost = req.headers.get("host");
  if (directHost) {
    const isSecure = req.nextUrl.protocol === "https:";
    try {
      return new URL(`${isSecure ? "https" : "http"}://${directHost}`);
    } catch {
      // fall through
    }
  }

  // 4. Last resort: what Next.js parsed (may be localhost behind a proxy).
  return req.nextUrl;
}

export function getWebAuthnContext(req: NextRequest) {
  const publicOrigin = resolvePublicOrigin(req);

  return {
    expectedOrigin: publicOrigin.origin,
    // rpID is the effective domain (hostname without port).
    rpID: publicOrigin.hostname,
  };
}
