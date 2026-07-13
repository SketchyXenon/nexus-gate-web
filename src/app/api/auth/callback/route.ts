// Allow up to 15s for Supabase PKCE code exchange.
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";

// ====================================================================
// GET /api/auth/callback?code=<pkce_code>&type=<magiclink|recovery|...>
// --------------------------------------------------------------------
// Server-side PKCE code exchange for Supabase Auth email redirects.
//
// After exchanging the code, checks the session's AMR (Authentication
// Methods Reference) claim to determine if this is a RECOVERY flow
// (password reset) or a regular login. The URL type param is used as
// a fallback only — Supabase PKCE redirects may not include it.
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

export async function GET(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      {
        error: "Authentication is not configured.",
        code: "AUTH_NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }

  const code = req.nextUrl.searchParams.get("code");
  const urlType = req.nextUrl.searchParams.get("type");

  if (!code) {
    return NextResponse.json(
      { error: "Missing authorization code.", code: "MISSING_CODE" },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error(
      "[auth/callback] exchangeCodeForSession failed:",
      error.message,
    );
    return NextResponse.json(
      { error: error.message, code: "EXCHANGE_FAILED" },
      { status: 400 },
    );
  }

  // Determine the auth type from the session's AMR claim.
  // This is more reliable than the URL type param, which Supabase PKCE
  // redirects may not include for password-reset flows.
  const { data: sessionData } = await supabase.auth.getSession();
  let resolvedType = urlType || "magiclink";

  if (sessionData.session) {
    const payload = decodeJwtPayload(sessionData.session.access_token) as {
      amr?: Array<{ method: string }>;
    };
    const isRecovery = payload.amr?.some((entry) => entry.method === "recovery");
    if (isRecovery) {
      resolvedType = "recovery";
    }
  }

  return NextResponse.json(
    { ok: true, type: resolvedType },
    { headers: { "Cache-Control": "no-store" } },
  );
}
