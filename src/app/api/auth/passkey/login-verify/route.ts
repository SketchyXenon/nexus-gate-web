import { NextRequest, NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { db } from "@/lib/db";
import { checkRateLimit } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getWebAuthnContext } from "@/lib/webauthn-context";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";

// POST /api/auth/passkey/login-verify
// Verifies the WebAuthn assertion and signs the user in via Supabase.
// Uses admin.generateLink to get a magic link, extracts the token, and
// consumes it via verifyOtp to establish a session.
export async function POST(req: NextRequest) {
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
    console.warn("[passkey/login-verify] missing assertion payload");
    return failWithCookieDelete(
      { error: "Missing authentication response.", code: "BAD_REQUEST" },
      400,
    );
  }

  const { rpID, expectedOrigin } = getWebAuthnContext(req);

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
      console.warn("[passkey/login-verify] verification threw for account");
      continue;
    }
  }

  if (!verifiedAccount) {
    console.warn("[passkey/login-verify] no matching passkey credential verified");
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
    console.warn(
      "[passkey/login-verify] verified account has no Supabase link",
    );
    return failWithCookieDelete(
      {
        error:
          "Account not linked to Supabase Auth. Use email/password or magic link first.",
        code: "NOT_LINKED",
      },
      400,
    );
  }

  // Establish a Supabase session for the verified user.
  // Strategy: use admin.generateLink to get a magic link, then use the
  // ANON client's verifyOtp with the hashed_token (NOT the raw token from
  // the action_link URL). The Supabase JS SDK verifyOtp method expects
  // the hashed_token, not the raw token. Using the anon client (not admin)
  // ensures the session cookie is set via @supabase/ssr.
  const admin = createSupabaseAdminClient();
  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({
      type: "magiclink",
      email: verifiedAccount.email,
    });
  if (linkError || !linkData) {
    console.error("[passkey] generateLink failed:", linkError?.message);
    return failWithCookieDelete(
      {
        error: "Could not establish session. Please try again.",
        code: "SESSION_FAILED",
      },
      500,
    );
  }

  // The hashed_token is what verifyOtp expects as token_hash.
  const hashedToken = linkData.properties?.hashed_token || "";
  if (!hashedToken) {
    console.error("[passkey] no hashed_token in linkData properties");
    return failWithCookieDelete(
      { error: "Could not establish session.", code: "SESSION_FAILED" },
      500,
    );
  }

  // Use the ANON (cookie-based) client to verify the OTP.
  const anonClient = await createSupabaseServerClient();
  const { data: sessionData, error: sessionError } =
    await anonClient.auth.verifyOtp({
      token_hash: hashedToken,
      type: "magiclink",
    });
  if (sessionError || !sessionData.session) {
    // If the anon client fails (PKCE mismatch), try the admin client as fallback.
    console.warn(
      "[passkey] anon verifyOtp failed, trying admin:",
      sessionError?.message,
    );
    const { data: adminSession, error: adminError } =
      await admin.auth.verifyOtp({
        token_hash: hashedToken,
        type: "magiclink",
      });
    if (adminError || !adminSession.session) {
      console.error(
        "[passkey] admin verifyOtp also failed:",
        adminError?.message,
      );
      return failWithCookieDelete(
        {
          error: "Could not establish session. Please try email login instead.",
          code: "SESSION_FAILED",
        },
        500,
      );
    }
    // Admin client got a session — set cookies manually.
    const session = adminSession.session;
    const isProduction = process.env.NODE_ENV === "production";
    const cookieOpts = {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: isProduction,
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    };
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
    response.cookies.set("sb-access-token", session.access_token, cookieOpts);
    response.cookies.set("sb-refresh-token", session.refresh_token, cookieOpts);
    if (isProduction) {
      response.cookies.set(
        "__Secure-sb-access-token",
        session.access_token,
        cookieOpts,
      );
      response.cookies.set(
        "__Secure-sb-refresh-token",
        session.refresh_token,
        cookieOpts,
      );
    }
    response.cookies.delete("ng_passkey_challenge");
    return response;
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

  // The anon client (createSupabaseServerClient) already set the session
  // cookies via @supabase/ssr's setAll callback. But in case that failed
  // (cookies().set() can fail in some contexts), also set them manually
  // on the response as a fallback.
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

  // Fallback: set cookies directly on the response.
  const cookieOpts = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProduction,
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  };
  response.cookies.set("sb-access-token", session.access_token, cookieOpts);
  response.cookies.set("sb-refresh-token", session.refresh_token, cookieOpts);
  if (isProduction) {
    response.cookies.set(
      "__Secure-sb-access-token",
      session.access_token,
      cookieOpts,
    );
    response.cookies.set(
      "__Secure-sb-refresh-token",
      session.refresh_token,
      cookieOpts,
    );
  }

  response.cookies.delete("ng_passkey_challenge");
  return response;
}
