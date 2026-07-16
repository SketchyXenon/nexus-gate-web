// Allow up to 15s for Supabase PKCE code exchange.
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  createSupabaseServerClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";
import { audit } from "@/lib/audit";
import { invalidateAccountCache } from "@/lib/supabase-session";
import { isDevAuthMode } from "@/lib/dev-auth";

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
  // Dev mode has no Supabase, so no callback is expected.
  if (isDevAuthMode()) {
    return NextResponse.json(
      { error: "Not available in dev mode.", code: "DEV_MODE" },
      { status: 503, headers: NO_STORE },
    );
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      {
        error: "Authentication is not configured.",
        code: "AUTH_NOT_CONFIGURED",
      },
      { status: 503, headers: NO_STORE },
    );
  }

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
  if (authUid && resolvedType !== "recovery") {
    try {
      const account = await db.account.findFirst({
        where: { supabaseAuthUid: authUid },
        select: {
          id: true,
          status: true,
          emailVerifiedAt: true,
          isDeactivated: true,
          email: true,
        },
      });

      if (account && !account.isDeactivated) {
        // Idempotent: only update if not already verified.
        if (
          !account.emailVerifiedAt ||
          account.status === "PENDING_VERIFICATION"
        ) {
          await db.account.update({
            where: { id: account.id },
            data: {
              status: "ACTIVE",
              emailVerifiedAt: account.emailVerifiedAt ?? new Date(),
            },
          });
          invalidateAccountCache(authUid);
          await audit({
            actorId: account.id,
            action: "auth.email_verified",
            targetType: "Account",
            targetId: account.id,
            metadata: { email: account.email, method: "supabase_callback" },
            req,
          }).catch(() => {});
        }
      }
    } catch (e) {
      // Non-critical: the session is still valid, login will handle activation.
      console.error("[auth/callback] account activation failed:", e);
    }
  }

  return NextResponse.json(
    { ok: true, type: resolvedType },
    { headers: NO_STORE },
  );
}
