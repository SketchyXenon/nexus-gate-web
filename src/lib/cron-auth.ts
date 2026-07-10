import type { NextRequest } from "next/server";

// ====================================================================
// Nexus Gate — Cron Authorization
// --------------------------------------------------------------------
// Supports multiple auth methods to maximize compatibility with
// third-party cron services (cron-job.org, Vercel Cron, EasyCron, etc.):
//
//   1. Authorization: Bearer <secret>         (Vercel Cron, generic)
//   2. Authorization: Basic <base64(user:secret)>  (cron-job.org "Password" field)
//   3. x-cron-secret / x-cronjob-secret header (custom header)
//   4. ?secret= / ?cron_secret= / ?token= query param (URL-based)
//   5. { "secret": "..." } JSON body field (POST body)
//
// The CRON_SECRET env var MUST be set. If not set, all requests are
// rejected (fail-closed) and a server-side error is logged.
// ====================================================================

export interface CronAuthResult {
  ok: boolean;
  reason?: string;
  method?: string;
}

/**
 * Check cron authorization. If `endpoint` is provided (e.g. "cleanup",
 * "reminders"), checks CRON_CLEANUP_SECRET / CRON_REMINDERS_SECRET first,
 * falling back to CRON_SECRET. This limits blast radius if one secret leaks.
 */
export function checkCronAuth(
  req: NextRequest,
  endpoint?: "cleanup" | "reminders",
): CronAuthResult {
  // Build the list of valid secrets: endpoint-specific first, then global.
  const secrets: string[] = [];
  if (endpoint) {
    const specific = (
      process.env[`CRON_${endpoint.toUpperCase()}_SECRET`] || ""
    ).trim();
    if (specific) secrets.push(specific);
  }
  const globalSecret = (process.env.CRON_SECRET || "").trim();
  if (globalSecret) secrets.push(globalSecret);

  if (secrets.length === 0) {
    return { ok: false, reason: "CRON_SECRET env var is not set" };
  }

  // Helper: check if a candidate matches ANY valid secret (constant-time per compare).
  const matchesAny = (candidate: string): boolean =>
    secrets.some((s) => constantTimeEqual(candidate, s));

  // ---- Method 1: Authorization: Bearer <secret> ----
  const authHeader = req.headers.get("authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (matchesAny(token)) {
      return { ok: true, method: "bearer" };
    }
    return { ok: false, reason: "Bearer token mismatch", method: "bearer" };
  }

  // ---- Method 2: Authorization: Basic <base64(user:secret)> ----
  // cron-job.org's "Password" field sends this format. We decode and
  // check if the PASSWORD portion matches CRON_SECRET (username is
  // ignored — only the secret matters).
  if (authHeader.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString(
        "utf-8",
      );
      // Format is "username:password" — take the part after the first colon
      const colonIdx = decoded.indexOf(":");
      const password = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded;
      if (matchesAny(password.trim())) {
        return { ok: true, method: "basic" };
      }
      return {
        ok: false,
        reason: "Basic auth password mismatch",
        method: "basic",
      };
    } catch {
      return { ok: false, reason: "Basic auth decode failed", method: "basic" };
    }
  }

  // ---- Method 3: Custom headers ----
  const headerSecret = (
    req.headers.get("x-cron-secret") ||
    req.headers.get("x-cronjob-secret") ||
    req.headers.get("x-cron-key") ||
    ""
  ).trim();
  if (headerSecret) {
    if (matchesAny(headerSecret)) {
      return { ok: true, method: "header" };
    }
    return {
      ok: false,
      reason: "Custom header secret mismatch",
      method: "header",
    };
  }

  // ---- Method 4: Query parameter ----
  const url = new URL(req.url);
  const querySecret = (
    url.searchParams.get("secret") ||
    url.searchParams.get("cron_secret") ||
    url.searchParams.get("cronsecret") ||
    url.searchParams.get("token") ||
    url.searchParams.get("key") ||
    ""
  ).trim();
  if (querySecret) {
    if (matchesAny(querySecret)) {
      return { ok: true, method: "query" };
    }
    return {
      ok: false,
      reason: "Query param secret mismatch",
      method: "query",
    };
  }

  // ---- Method 5: JSON body field (only for POST/PUT) ----
  // NOTE: We can't read the body here without consuming it. The route
  // handler reads the body and passes the secret separately. This is
  // handled in the route itself via a helper. For now, return "no auth
  // method found" and let the route try body auth if needed.
  return { ok: false, reason: "No auth credentials provided" };
}

// Backward-compatible boolean wrapper.
export function isAuthorizedCronRequest(req: NextRequest): boolean {
  return checkCronAuth(req).ok;
}

// Timing-safe string comparison (constant-time).
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Helper for routes that want to read the secret from a JSON body field.
// Returns true if the body's "secret" or "cron_secret" field matches any
// valid secret (endpoint-specific or global).
export function checkBodySecret(
  body: unknown,
  endpoint?: "cleanup" | "reminders",
): boolean {
  const secrets: string[] = [];
  if (endpoint) {
    const specific = (
      process.env[`CRON_${endpoint.toUpperCase()}_SECRET`] || ""
    ).trim();
    if (specific) secrets.push(specific);
  }
  const globalSecret = (process.env.CRON_SECRET || "").trim();
  if (globalSecret) secrets.push(globalSecret);

  if (secrets.length === 0 || !body || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;
  const secret =
    (obj.secret as string) ||
    (obj.cron_secret as string) ||
    (obj.token as string) ||
    "";
  if (typeof secret !== "string") return false;
  return secrets.some((s) => constantTimeEqual(secret.trim(), s));
}
