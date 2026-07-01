// ====================================================================
// Nexus Gate — Cloudflare Turnstile Server-Side Verification
// ====================================================================
//
// This is the REAL anti-bot boundary. The client-side TurnstileGate is
// just UX friction; THIS module verifies the token with Cloudflare's
// siteverify API, so a bot that bypasses the client widget (e.g. by
// POSTing directly) is still rejected.
//
// FLOW:
//   1. Client renders an invisible Turnstile widget in the form.
//   2. Widget produces a one-time token (cf-turnstile-response).
//   3. Form submits the token alongside email/password.
//   4. This module POSTs {secret, response, remoteip} to Cloudflare.
//   5. Cloudflare returns {success: true/false, ...error codes}.
//   6. If success=false (token invalid) → 403 (fail-closed: block).
//   7. If siteverify is UNREACHABLE (network/timeout/5xx) → allow + log
//      (fail-open: don't lock users out during Cloudflare outages).
//
// GRACEFUL DEGRADATION:
//   If TURNSTILE_SECRET_KEY is not set → verification SKIPPED (dev/local).
//   If Cloudflare's siteverify is unreachable → verification SKIPPED
//   (fail-open) + logged + circuit breaker trips after N consecutive
//   failures to avoid hammering a down service.
//
// SECURITY TRADEOFF:
//   Fail-open on infrastructure errors means a bot COULD theoretically
//   bypass Turnstile during a Cloudflare outage. This is acceptable
//   because: (a) the server-side rate limiter still throttles brute
//   force, (b) bcrypt password hashing still slows credential stuffing,
//   (c) locking ALL users out of login during a Cloudflare outage is a
//   worse outcome than a temporary slight bot-risk increase.
// ====================================================================

import { NextResponse, type NextRequest } from "next/server";
import { getClientIp } from "@/lib/api";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Cloudflare siteverify error codes that indicate the TOKEN was invalid.
// These are CLIENT/ATTACKER problems → fail-closed (block).
const TOKEN_INVALID_CODES = new Set([
  "missing-input-response",   // No token — client bypassed the widget
  "invalid-input-response",   // Token invalid/expired/already-used
  "timeout-or-duplicate",     // Token already validated or expired
]);

// Codes that indicate a SERVER/CONFIG problem → fail-open (allow + log).
const INFRA_ERROR_CODES = new Set([
  "missing-input-secret",     // Server misconfiguration
  "invalid-input-secret",     // Server misconfiguration
  "bad-request",              // Malformed request (our fault)
  "internal-error",           // Cloudflare internal error — retry
]);

// Human-readable reasons for server-side logging (never sent to client).
const ERROR_REASONS: Record<string, string> = {
  "missing-input-secret": "The secret key was not passed (server misconfiguration).",
  "invalid-input-secret": "The secret key was invalid or malformed.",
  "missing-input-response": "The Turnstile token was not passed (client bypassed the widget).",
  "invalid-input-response": "The Turnstile token was invalid, expired, or already used.",
  "bad-request": "The request was rejected because it was malformed.",
  "timeout-or-duplicate": "The token was already validated or has expired (token is single-use, 300s TTL).",
  "internal-error": "Cloudflare internal error — retry.",
};

export function isTurnstileEnabled(): boolean {
  return !!process.env.TURNSTILE_SECRET_KEY;
}

interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
  metadata?: {
    result?: string;
    reason?: string;
  };
}

// ---- Circuit breaker ----
// If Cloudflare's siteverify fails N times in a row with infrastructure
// errors (network/timeout/5xx), trip the breaker for COOLDOWN_MS so we
// stop hammering a down service and just fail-open immediately. This
// prevents every login attempt from waiting 5s for a timeout during an
// outage. The breaker resets on the first successful verification.
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60_000; // 1 minute
let circuitFailures = 0;
let circuitTrippedUntil = 0;

function isCircuitOpen(): boolean {
  return Date.now() < circuitTrippedUntil;
}

function recordInfraFailure() {
  circuitFailures++;
  if (circuitFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuitTrippedUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    console.error(
      `[turnstile] circuit breaker OPEN — Cloudflare siteverify failed ${circuitFailures}x consecutively. ` +
        `Failing open for ${CIRCUIT_COOLDOWN_MS / 1000}s. Bots could bypass verification during this window.`
    );
  }
}

function recordSuccess() {
  if (circuitFailures > 0 || circuitTrippedUntil > 0) {
    console.log("[turnstile] circuit breaker CLOSED — Cloudflare siteverify recovered.");
  }
  circuitFailures = 0;
  circuitTrippedUntil = 0;
}

type VerifyOutcome =
  | { ok: true }
  | { ok: false; kind: "invalid_token"; reason: string } // fail-closed
  | { ok: false; kind: "infra_error"; reason: string }; // fail-open

// Verify a Turnstile token with Cloudflare. Distinguishes between
// "token was invalid" (fail-closed) and "siteverify was unreachable"
// (fail-open). This is the key to surviving Cloudflare outages.
async function verifyWithCloudflare(
  token: string,
  remoteIp?: string
): Promise<VerifyOutcome> {
  // Circuit breaker: if Cloudflare has been failing repeatedly, skip the
  // call entirely and fail-open immediately (don't make the user wait 5s).
  if (isCircuitOpen()) {
    return { ok: false, kind: "infra_error", reason: "circuit breaker open" };
  }

  const secret = process.env.TURNSTILE_SECRET_KEY!;
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      // Don't let a slow Cloudflare response hang the request.
      signal: AbortSignal.timeout(5000),
    });

    // HTTP 5xx from Cloudflare = infrastructure problem → fail-open.
    if (!res.ok) {
      recordInfraFailure();
      return { ok: false, kind: "infra_error", reason: `siteverify HTTP ${res.status}` };
    }

    const data = (await res.json()) as SiteverifyResponse;

    if (!data.success) {
      const codes = data["error-codes"] || [];

      // Classify: is this a token problem (fail-closed) or an infra
      // problem (fail-open)?
      const hasTokenError = codes.some((c) => TOKEN_INVALID_CODES.has(c));
      const hasInfraError = codes.some((c) => INFRA_ERROR_CODES.has(c));

      if (hasInfraError && !hasTokenError) {
        // Pure infrastructure error → fail-open.
        recordInfraFailure();
        const reason = codes.map((c) => ERROR_REASONS[c] || c).join("; ");
        return { ok: false, kind: "infra_error", reason };
      }

      // Token error (or unknown error) → fail-closed. A real user would
      // get a valid token; an attacker sending a bad token gets blocked.
      const reason = codes.map((c) => ERROR_REASONS[c] || c).join("; ");
      return { ok: false, kind: "invalid_token", reason: reason || "verification failed" };
    }

    recordSuccess();
    return { ok: true };
  } catch (e) {
    // Network error / timeout = Cloudflare unreachable → fail-open.
    recordInfraFailure();
    const msg = e instanceof Error ? e.message : "fetch failed";
    return { ok: false, kind: "infra_error", reason: `siteverify error: ${msg}` };
  }
}

// Helper for API routes: verifies the Turnstile token from the request
// body. Returns null if OK (proceed with the request), or a NextResponse
// (403) if the token is missing/invalid. Logs the reason server-side.
//
// CRITICAL BEHAVIOR:
//   - Missing token (bot bypassed widget) → 403 (fail-closed)
//   - Invalid token (bad/expired/reused) → 403 (fail-closed)
//   - Cloudflare unreachable (network/timeout/5xx) → ALLOW + log
//     (fail-open — don't lock users out during Cloudflare outages)
//
// Usage in a route:
//   const turnstileError = await requireTurnstile(req, body);
//   if (turnstileError) return turnstileError;
export async function requireTurnstile(
  req: NextRequest,
  body: { cfToken?: string } | null
): Promise<NextResponse | null> {
  // Graceful degradation: if no secret is configured, skip verification.
  if (!isTurnstileEnabled()) {
    return null;
  }

  const token = body?.cfToken;

  // Missing token — the client either bypassed the widget or it failed
  // to load. This is fail-CLOSED: a bot POSTing without a token is blocked.
  // (A real user whose widget failed to load gets a clear message to refresh.)
  if (!token || typeof token !== "string" || token.length < 10) {
    return NextResponse.json(
      { error: "Bot verification is required. Please refresh the page and try again.", code: "TURNSTILE_REQUIRED" },
      { status: 403 }
    );
  }

  const ip = getClientIp(req);
  const outcome = await verifyWithCloudflare(token, ip);

  if (outcome.ok) {
    return null; // OK — proceed with the request
  }

  if (outcome.kind === "infra_error") {
    // Cloudflare is unreachable (or circuit breaker is open). FAIL OPEN:
    // let the user through, log it for monitoring. The rate limiter +
    // bcrypt still provide baseline protection.
    console.warn(
      `[turnstile] FAIL-OPEN (Cloudflare unreachable): ${outcome.reason}. ` +
        `Request allowed — rate limiter + bcrypt still active.`
    );
    return null;
  }

  // invalid_token → fail-closed. Log the real reason, return a generic
  // message to the client (no info leak).
  console.warn("[turnstile] verification failed (token invalid):", outcome.reason);
  return NextResponse.json(
    { error: "Bot verification failed. Please refresh the page and try again.", code: "TURNSTILE_FAILED" },
    { status: 403 }
  );
}
