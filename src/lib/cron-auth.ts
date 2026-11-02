import type { NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "crypto";

// ====================================================================
// Nexus Gate - Cron Authorization
// --------------------------------------------------------------------
// Supports multiple auth methods to maximize compatibility with
// third-party cron services (cron-job.org, Vercel Cron, EasyCron, etc.):
//
//   1. Authorization: Bearer <secret>         (Vercel Cron, generic)
//   2. Authorization: Basic <base64(user:secret)>  (cron-job.org "Password" field)
//   3. x-cron-secret / x-cronjob-secret header (custom header)
//   4. { "secret": "..." } JSON body field (POST body)
//
// The ?secret= / ?cron_secret= / ?token= query-param method is DEPRECATED
// (M4 fix): query params are logged by proxies/CDNs (access logs, Referer
// headers, browser history) and leak the secret. Header-based auth (methods
// 1-3) keeps the secret out of URLs. The query param is still accepted for
// backward compatibility with existing cron jobs, but logs a deprecation
// warning so operators migrate. To migrate: move the secret from the URL
// to an Authorization header or x-cron-secret header.
//
// The CRON_SECRET env var MUST be set. If not set, all requests are
// rejected (fail-closed) and a server-side error is logged.
// ====================================================================

export interface CronAuthResult {
  ok: boolean;
  reason?: string;
  method?: string;
}

// Throttle the deprecation warning to one per server instance (avoids log
// spam if a cron job hits the query-param method every minute).
let queryAuthWarned = false;

/**
 * Check cron authorization. If `endpoint` is provided (e.g. "cleanup",
 * "reminders", "keepalive"), checks CRON_CLEANUP_SECRET /
 * CRON_REMINDERS_SECRET / CRON_KEEPALIVE_SECRET first, falling back to
 * CRON_SECRET. This limits blast radius if one secret leaks.
 *
 * L1 FIX (hardening pass 2026-11-02): ALL credentials present on the
 * request are now evaluated before failing. Previously the check
 * early-returned on the FIRST recognized method, so a client sending a
 * rotated/stale `Authorization: Bearer <old>` PLUS a valid
 * `x-cron-secret` got a 401 despite carrying a valid credential - a
 * confusing, order-dependent failure. Order now never matters: every
 * candidate is checked, and the FIRST MATCH wins (method precedence in
 * the result is informational only). A malformed Basic header likewise
 * no longer aborts evaluation of the remaining methods.
 */
export function checkCronAuth(
  req: NextRequest,
  endpoint?: "cleanup" | "reminders" | "keepalive",
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

  // Collect EVERY credential present on the request (L1 fix).
  const candidates: Array<{ value: string; method: string }> = [];

  // ---- Candidate source 1: Authorization: Bearer <secret> ----
  const authHeader = req.headers.get("authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) candidates.push({ value: token, method: "bearer" });
  }

  // ---- Candidate source 2: Authorization: Basic <base64(user:secret)> ----
  // cron-job.org's "Password" field sends this format. We decode and
  // check if the PASSWORD portion matches CRON_SECRET (username is
  // ignored - only the secret matters). Decode failure is recorded but
  // does NOT abort the remaining candidates (L1 fix).
  if (authHeader.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString(
        "utf-8",
      );
      // Format is "username:password" - take the part after the first colon
      const colonIdx = decoded.indexOf(":");
      const password = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded;
      const trimmed = password.trim();
      if (trimmed) candidates.push({ value: trimmed, method: "basic" });
    } catch {
      // Malformed base64 - fall through to the remaining candidates.
    }
  }

  // ---- Candidate source 3: Custom headers ----
  const headerSecret = (
    req.headers.get("x-cron-secret") ||
    req.headers.get("x-cronjob-secret") ||
    req.headers.get("x-cron-key") ||
    ""
  ).trim();
  if (headerSecret) {
    candidates.push({ value: headerSecret, method: "header" });
  }

  // ---- Candidate source 4: Query parameter (DEPRECATED - leaks secret via logs) ----
  // Kept for backward compatibility with existing cron jobs that put the
  // secret in the URL. Logs a one-time warning so operators migrate to a
  // header-based method (Bearer / x-cron-secret). Per
  // 06-security-architecture.md §9, query params are captured in proxy
  // access logs, Referer headers, and browser history - all of which
  // leak the secret.
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
    // Deprecation warning (throttled via a module-level flag to avoid log spam).
    if (!queryAuthWarned) {
      queryAuthWarned = true;
      console.warn(
        "[cron-auth] DEPRECATED: query-param secret auth detected. Move the" +
          " secret to an Authorization: Bearer header or x-cron-secret header." +
          " Query params leak via access logs / Referer / browser history.",
      );
    }
    candidates.push({ value: querySecret, method: "query-deprecated" });
  }

  // ---- Evaluate ALL candidates (L1 fix): first match wins ----
  for (const candidate of candidates) {
    if (matchesAny(candidate.value)) {
      return { ok: true, method: candidate.method };
    }
  }

  // ---- No candidate matched: report which methods were ATTEMPTED ----
  // (names only - never the values). Empty candidates => no credentials.
  const attempted = [...new Set(candidates.map((c) => c.method))];
  return {
    ok: false,
    reason:
      attempted.length > 0
        ? `All provided credentials mismatch (attempted: ${attempted.join(", ")})`
        : "No auth credentials provided",
    method: attempted[0],
  };
}

// Backward-compatible boolean wrapper.
export function isAuthorizedCronRequest(req: NextRequest): boolean {
  return checkCronAuth(req).ok;
}

// Timing-safe string comparison (constant-time).
// L7 (hardening pass 2026-11-02): the previous implementation early-
// returned when lengths differed, leaking the secret's LENGTH via
// timing (cheap for an attacker to measure against a known-prefix
// endpoint). Both sides are now SHA-256 digested first, so
// timingSafeEqual always compares fixed 32-byte buffers - constant
// time regardless of input content or length.
function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const dbb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, dbb);
}

// Helper for routes that want to read the secret from a JSON body field.
// Returns true if the body's "secret" or "cron_secret" field matches any
// valid secret (endpoint-specific or global).
export function checkBodySecret(
  body: unknown,
  endpoint?: "cleanup" | "reminders" | "keepalive",
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
