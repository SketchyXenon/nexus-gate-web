import { NextRequest, NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { db } from "@/lib/db";
import { checkRateLimit, badRequest } from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  createSupabaseAdminClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";

// POST /api/auth/passkey/login-verify
// Verifies the WebAuthn assertion and signs the user in via Supabase.
// Since Supabase doesn't expose a "sign in as user X" server API, we
// generate a one-time magic link and consume it immediately server-side.
export async function POST(req: NextRequest) {
  // Helper: delete the challenge cookie on any failure path (single-use).
  const failWithCookieDelete = (body: object, status: number) => {
    const resp = NextResponse.json(body, { status });
    resp.cookies.delete("ng_passkey_challenge");
    return resp;
  };

  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      {
        error: "Authentication is not configured.",
        code: "AUTH_NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }
  const rl = await checkRateLimit(req, "login");
  if (rl) return rl;

  const challenge = req.cookies.get("ng_passkey_challenge")?.value;
  if (!challenge) {
    return failWithCookieDelete(
      {
        error: "Challenge expired. Please try again.",
        code: "CHALLENGE_EXPIRED",
      },
      400,
    );
  }

  const body = await req.json().catch(() => null);
  if (!body?.assertion) {
    return failWithCookieDelete(
      { error: "Missing authentication response.", code: "BAD_REQUEST" },
      400,
    );
  }

  const rpID = process.env.NEXT_PUBLIC_APP_URL
    ? new URL(process.env.NEXT_PUBLIC_APP_URL).hostname
    : "localhost";
  const expectedOrigin =
    process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  // Find the account that owns this credential by scanning passkey holders.
  const accounts = await db.account.findMany({
    where: { passkeyCredential: { not: null } },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      status: true,
      studentId: true,
      program: true,
      section: true,
      supabaseAuthUid: true,
      passkeyCredential: true,
    },
  });

  let verifiedAccount: (typeof accounts)[0] | null = null;
  for (const acc of accounts) {
    try {
      const stored = JSON.parse(acc.passkeyCredential || "{}");
      if (!stored.publicKey) continue;
      const verification = await verifyAuthenticationResponse({
        response: body.assertion as AuthenticationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin,
        expectedRPID: rpID,
        credential: {
          id: stored.id,
          publicKey: stored.publicKey,
          counter: stored.counter,
          transports: stored.transports,
        },
      });
      if (verification.verified) {
        verifiedAccount = acc;
        stored.counter = verification.authenticationInfo.newCounter;
        await db.account.update({
          where: { id: acc.id },
          data: { passkeyCredential: JSON.stringify(stored) },
        });
        break;
      }
    } catch {
      continue;
    }
  }

  if (!verifiedAccount) {
    return failWithCookieDelete(
      { error: "Passkey verification failed.", code: "VERIFICATION_FAILED" },
      400,
    );
  }
  if (verifiedAccount.status === "SUSPENDED") {
    return failWithCookieDelete(
      { error: "Your account has been suspended.", code: "SUSPENDED" },
      403,
    );
  }
  if (!verifiedAccount.supabaseAuthUid) {
    return failWithCookieDelete(
      {
        error:
          "Account not linked to Supabase Auth. Use email/password or magic link first.",
        code: "NOT_LINKED",
      },
      400,
    );
  }

  // Sign the user in via Supabase: generate a magic link and consume it.
  // This is the only server-side way to establish a Supabase session for a
  // user without their password. The link is single-use and immediately consumed.
  const admin = createSupabaseAdminClient();
  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({
      type: "magiclink",
      email: verifiedAccount.email,
    });
  if (linkError || !linkData) {
    console.error("[passkey] generateLink failed:", linkError?.message);
    return failWithCookieDelete(
      { error: "Could not establish session.", code: "SESSION_FAILED" },
      400,
    );
  }

  // Consume the magic link OTP to get a session access_token.
  const { data: sessionData, error: sessionError } = await admin.auth.verifyOtp(
    {
      token_hash: linkData.properties?.hashed_token || "",
      type: "magiclink",
    },
  );
  if (sessionError || !sessionData.session) {
    console.error("[passkey] verifyOtp failed:", sessionError?.message);
    return failWithCookieDelete(
      { error: "Could not establish session.", code: "SESSION_FAILED" },
      400,
    );
  }

  // Activate pending accounts on first passkey login.
  if (verifiedAccount.status === "PENDING_VERIFICATION") {
    await db.account.update({
      where: { id: verifiedAccount.id },
      data: { status: "ACTIVE", lastLoginAt: new Date() },
    });
    (verifiedAccount as { status: string }).status = "ACTIVE";
  }
  await db.account.update({
    where: { id: verifiedAccount.id },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    },
  });

  await audit({
    actorId: verifiedAccount.id,
    action: "auth.passkey_login",
    targetType: "Account",
    targetId: verifiedAccount.id,
    req,
  }).catch(() => {});

  // Set the Supabase session cookies directly on the response.
  // We can't use createSupabaseServerClient().auth.setSession() here because
  // it tries to set cookies via next/headers cookies().set(), which can fail
  // in certain contexts. Instead, we set the cookies manually with the same
  // names + options that @supabase/ssr uses.
  const isProduction = process.env.NODE_ENV === "production";
  const session = sessionData.session;
  const response = NextResponse.json({
    ok: true,
    account: {
      id: verifiedAccount.id,
      email: verifiedAccount.email,
      fullName: verifiedAccount.fullName,
      role: verifiedAccount.role,
      status: verifiedAccount.status,
      studentId: verifiedAccount.studentId,
      program: verifiedAccount.program,
      section: verifiedAccount.section,
    },
  });

  // Set the Supabase auth session cookies (same names @supabase/ssr uses).
  const cookiePrefix = isProduction ? "__Secure-" : "";
  const cookieOpts = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProduction,
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days (matches Supabase default)
  };
  response.cookies.set(
    `${cookiePrefix}sb-access-token`,
    session.access_token,
    cookieOpts,
  );
  response.cookies.set(
    `${cookiePrefix}sb-refresh-token`,
    session.refresh_token,
    cookieOpts,
  );
  // Also set the non-prefixed version for dev compatibility.
  if (isProduction) {
    response.cookies.set("sb-access-token", session.access_token, cookieOpts);
    response.cookies.set("sb-refresh-token", session.refresh_token, cookieOpts);
  }

  response.cookies.delete("ng_passkey_challenge");
  return response;
}
