// ====================================================================
// Nexus Gate - JWT Session Resolver
//
// Validates the Supabase access token locally using jose (no network
// round-trip), eliminating the 50-150ms getUser() call per request.
//
// Requires SUPABASE_JWT_SECRET env var (from Supabase Dashboard >
// Project Settings > API > JWT Secret). If not set, falls back to
// the network-based getUser() path in supabase-session.ts.
//
// Supabase signs access tokens with HS256 using the project JWT secret.
// The token's `sub` claim is the Supabase auth user ID (authUid).
// ====================================================================

import "server-only";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { cookies } from "next/headers";

// The Supabase access token cookie name (set by @supabase/ssr).
// Format: sb-<project-ref>-auth-token
const SB_COOKIE_PREFIX = "sb-";
const SB_COOKIE_SUFFIX = "-auth-token";

function getJwtSecret(): Uint8Array | null {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) return null;
  return new TextEncoder().encode(secret);
}

function getProjectRef(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  // https://<project-ref>.supabase.co
  const match = url.match(/https?:\/\/([^.]+)\.supabase\./);
  return match?.[1] ?? null;
}

// Read the raw access token from the Supabase session cookie.
async function readAccessToken(): Promise<string | null> {
  const cookieStore = await cookies();
  const projectRef = getProjectRef();
  if (projectRef) {
    const cookieName = `${SB_COOKIE_PREFIX}${projectRef}${SB_COOKIE_SUFFIX}`;
    const cookie = cookieStore.get(cookieName);
    if (cookie?.value) {
      // The cookie value may be a JSON-encoded chunked token or the raw JWT.
      // @supabase/ssr stores it as a base64-encoded JSON string.
      try {
        const decoded = JSON.parse(atob(cookie.value));
        if (decoded.access_token) return decoded.access_token;
      } catch {
        // Not JSON - might be the raw JWT (older Supabase versions).
        if (cookie.value.split(".").length === 3) return cookie.value;
      }
    }
  }
  // Fallback: scan all cookies for one matching the Supabase pattern.
  for (const cookie of cookieStore.getAll()) {
    if (
      cookie.name.startsWith(SB_COOKIE_PREFIX) &&
      cookie.name.endsWith(SB_COOKIE_SUFFIX)
    ) {
      try {
        const decoded = JSON.parse(atob(cookie.value));
        if (decoded.access_token) return decoded.access_token;
      } catch {
        if (cookie.value.split(".").length === 3) return cookie.value;
      }
    }
  }
  return null;
}

export interface JwtSession {
  authUid: string;
  email: string;
}

// Returns true if local JWT validation is available (secret configured).
export function isJwtValidationAvailable(): boolean {
  return getJwtSecret() !== null;
}

// Validate the Supabase access token locally and extract the authUid.
// Returns null if no token, invalid token, or JWT secret not configured.
export async function getJwtSession(): Promise<JwtSession | null> {
  const secret = getJwtSecret();
  if (!secret) return null;

  const token = await readAccessToken();
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      // Supabase tokens include these claims.
      issuer: process.env.NEXT_PUBLIC_SUPABASE_URL,
    });
    const authUid = payload.sub;
    if (!authUid) return null;
    const email =
      (payload.email as string) ||
      (payload["user_email"] as string) ||
      "";
    return { authUid, email };
  } catch {
    // Token invalid, expired, or signature mismatch.
    return null;
  }
}
