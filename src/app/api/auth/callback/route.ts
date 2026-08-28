// Allow up to 15s for Supabase PKCE code exchange.
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import {
  createSupabaseServerClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";
import { audit } from "@/lib/audit";
import { invalidateAccountCache } from "@/lib/supabase-session";
import {
  safeFindAccountByAuthUid,
  isAccountDeactivated,
} from "@/lib/safe-account";
import { checkRateLimit } from "@/lib/api";
import { MFA_CHALLENGE_COOKIE, signChallenge } from "@/lib/mfa";

// ====================================================================
// GET /api/auth/callback?code=<pkce_code>&type=<magiclink|recovery|...>
//
// Server-side PKCE code exchange for Supabase Auth email redirects.
//
// After exchanging the code, checks the session's AMR (Authentication
// Methods Reference) claim to determine if this is a RECOVERY flow
// (password reset) or a signup/magiclink confirmation.
//
// On signup confirmation: flips the account from PENDING_VERIFICATION to
// ACTIVE and records emailVerifiedAt. This is the single point where
// Supabase's email confirmation meets our accounts table.
//
// Idempotent: if the account is already ACTIVE, this is a no-op.
// Cache-Control: no-store prevents caching of the auth response.
// ====================================================================

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) return {};
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  try {
    return JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
  } catch {
    return {};
  }
}

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export async function GET(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      {
        error: "Authentication is not configured.",
        code: "AUTH_NOT_CONFIGURED",
      },
      { status: 503, headers: NO_STORE },
    );
  }

  // Rate-limit: the callback is unauthenticated and hits Supabase on every
  // request. Without this, an attacker can amplify DoS by hammering this
  // endpoint (each call triggers a Supabase PKCE exchange).
  const rl = await checkRateLimit(req, "api");
  if (rl) return rl;

  const code = req.nextUrl.searchParams.get("code");
  const urlType = req.nextUrl.searchParams.get("type");

  if (!code || code.length < 8) {
    return NextResponse.json(
      { error: "Missing or invalid authorization code.", code: "MISSING_CODE" },
      { status: 400, headers: NO_STORE },
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error(
      "[auth/callback] exchangeCodeForSession failed:",
      error.message,
    );
    // Map common Supabase errors to user-friendly messages.
    const msg = error.message.toLowerCase();
    let userMessage = "This link is invalid or has expired.";
    let statusCode = 400;
    if (msg.includes("expired") || msg.includes("timeout")) {
      userMessage =
        "This confirmation link has expired. Please request a new one.";
      statusCode = 410;
    } else if (msg.includes("already") || msg.includes("used")) {
      userMessage =
        "This confirmation link has already been used. You can sign in now.";
      statusCode = 409;
    }
    return NextResponse.json(
      { error: userMessage, code: "EXCHANGE_FAILED" },
      { status: statusCode, headers: NO_STORE },
    );
  }

  // Determine the auth type from the session's AMR claim.
  const { data: sessionData } = await supabase.auth.getSession();
  let resolvedType = urlType || "magiclink";
  let authUid: string | null = null;

  if (sessionData.session) {
    authUid = sessionData.session.user.id;
    const payload = decodeJwtPayload(sessionData.session.access_token) as {
      amr?: Array<{ method: string }>;
    };
    const isRecovery = payload.amr?.some(
      (entry) => entry.method === "recovery",
    );
    if (isRecovery) {
      resolvedType = "recovery";
    }
  }

  // On signup/magiclink confirmation: activate the account.
  // This is the single point where Supabase's email confirmation
  // transitions our account from PENDING_VERIFICATION to ACTIVE.
  let wasSignupConfirmation = false;
  let mfaRequired = false;
  if (authUid && resolvedType !== "recovery") {
    try {
      // Safe lookup: degrades if migration 0017 not applied. Includes
      // mfaEnabled + lockout columns so this route can enforce the same
      // brute-force lockout and MFA gate as the password login route.
      const account = await safeFindAccountByAuthUid(authUid);

      if (account) {
        if (isAccountDeactivated(account)) {
          // Deactivated accounts must NOT hold a session. Deactivation does
          // not delete the Supabase Auth user, so a magic link can still be
          // delivered and exchanged - revoke the session here so a
          // deactivated user cannot authenticate via magic link.
          await supabase.auth.signOut().catch(() => {});
        } else if (account.status === "PENDING_VERIFICATION") {
          // Signup confirmation: flip to ACTIVE, then sign out so the user
          // authenticates explicitly with a password (they only proved email
          // control so far).
          wasSignupConfirmation = true;
          try {
            await db.account.update({
              where: { id: account.id },
              data: {
                status: "ACTIVE",
                emailVerifiedAt: account.emailVerifiedAt ?? new Date(),
              },
            });
          } catch {
            // Migration 0017 not applied - update status only.
            await db.account.update({
              where: { id: account.id },
              data: { status: "ACTIVE" },
            });
          }
          invalidateAccountCache(authUid);
          await audit({
            actorId: account.id,
            action: "auth.email_verified",
            targetType: "Account",
            targetId: account.id,
            metadata: { email: account.email, method: "supabase_callback" },
            req,
          }).catch(() => {});
          await supabase.auth.signOut().catch(() => {});
        } else if (account.status === "ACTIVE") {
          // Magic-link sign-in to an already-ACTIVE account: the session IS
          // the authentication. But the same protections as password login
          // apply BEFORE the session is honored:
          if (account.lockedUntil && account.lockedUntil > new Date()) {
            // Brute-force lockout: without this check, an attacker with
            // access to the victim's inbox could bypass the 5-fail/15-min
            // lock by requesting a magic link instead (audit HIGH).
            await supabase.auth.signOut().catch(() => {});
            const retryMs = account.lockedUntil.getTime() - Date.now();
            return NextResponse.json(
              {
                error: `Too many failed attempts. Please try again in ${Math.ceil(retryMs / 1000)} seconds.`,
                code: "LOCKED",
                retryAfterMs: retryMs,
              },
              { status: 423, headers: NO_STORE },
            );
          }
          if (account.mfaEnabled) {
            // MFA gate (same policy as the password login route): the
            // magic-link session alone must NOT be enough to use the app
            // when the account has a second factor. Issue an MFA challenge
            // (DB row + signed 5-min cookie) and tell the client to show
            // the OTP input; /api/auth/mfa/login-verify completes the flow
            // by setting ng_mfa_verified. Without this, MFA users bounced
            // between the callback and /api/auth/me in a fail-closed loop.
            mfaRequired = true;
            const challengeId = randomUUID();
            await db.mfaChallenge.create({
              data: {
                id: challengeId,
                accountId: account.id,
                expiresAt: new Date(Date.now() + 5 * 60 * 1000),
              },
            });
            const challengeJwt = await signChallenge(challengeId, account.id);
            const resp = NextResponse.json(
              { ok: true, type: resolvedType, mfaRequired },
              { headers: NO_STORE },
            );
            resp.cookies.set(MFA_CHALLENGE_COOKIE, challengeJwt, {
              httpOnly: true,
              sameSite: "lax",
              secure: process.env.NODE_ENV === "production",
              path: "/",
              maxAge: 5 * 60,
            });
            // Magic-link sign-in has no remember-me checkbox: the MFA
            // intent cookie is always "0" so login-verify keeps the
            // session browser-scoped (mirrors the ADMIN policy).
            resp.cookies.set("ng_mfa_remember", "0", {
              httpOnly: true,
              sameSite: "lax",
              secure: process.env.NODE_ENV === "production",
              path: "/",
              maxAge: 5 * 60,
            });
            await audit({
              actorId: account.id,
              action: "auth.mfa_challenge",
              targetType: "Account",
              targetId: account.id,
              metadata: { via: "magic_link" },
              req,
            }).catch(() => {});
            return resp;
          }
          // Successful magic-link sign-in without MFA: reset the
          // brute-force counters and stamp lastLoginAt, exactly like the
          // password login route (previously this path never touched them,
          // so a locked-out counter persisted after a successful link
          // sign-in and lastLoginAt went stale).
          await db.account
            .update({
              where: { id: account.id },
              data: {
                failedLoginAttempts: 0,
                lockedUntil: null,
                lastLoginAt: new Date(),
              },
            })
            .catch(() => {});
          await audit({
            actorId: account.id,
            action: "auth.login",
            targetType: "Account",
            targetId: account.id,
            metadata: { method: "magic_link" },
            req,
          }).catch(() => {});
        } else {
          // Any other status (e.g. SUSPENDED): the account is not in good
          // standing. Sign out so the user cannot use a magic link to
          // bypass a suspension.
          await supabase.auth.signOut().catch(() => {});
        }
      }
    } catch (e) {
      // Non-critical: the session is still valid, login will handle activation.
      console.error("[auth/callback] account activation failed:", e);
    }
  }

  return NextResponse.json(
    { ok: true, type: resolvedType, wasSignupConfirmation, mfaRequired },
    { headers: NO_STORE },
  );
}
