import { NextRequest, NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { db } from "@/lib/db";
import { checkRateLimit } from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  createSupabaseAdminClient,
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

  // Establish a Supabase session for the verified user.
  // generateLink with type "magiclink" returns an action_link containing
  // the token. We extract the token from the URL and verify it to get a session.
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

  // The action_link contains the token as a query param: ...&token=xxx&type=magiclink
  // Extract the token and use it with verifyOtp.
  const actionLink = linkData.properties?.action_link || "";
  let token = "";
  try {
    const url = new URL(actionLink);
    token = url.searchParams.get("token") || "";
  } catch {
    console.error("[passkey] could not parse action_link:", actionLink);
    return failWithCookieDelete(
      { error: "Could not establish session.", code: "SESSION_FAILED" },
      500,
    );
  }

  if (!token) {
    console.error("[passkey] no token in action_link");
    return failWithCookieDelete(
      { error: "Could not establish session.", code: "SESSION_FAILED" },
      500,
    );
  }

  const { data: sessionData, error: sessionError } = await admin.auth.verifyOtp(
    {
      token_hash: token,
      type: "magiclink",
    },
  );
  if (sessionError || !sessionData.session) {
    console.error("[passkey] verifyOtp failed:", sessionError?.message);
    return failWithCookieDelete(
      { error: "Could not establish session.", code: "SESSION_FAILED" },
      500,
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

  const cookiePrefix = isProduction ? "__Secure-" : "";
  const cookieOpts = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProduction,
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
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
  if (isProduction) {
    response.cookies.set("sb-access-token", session.access_token, cookieOpts);
    response.cookies.set("sb-refresh-token", session.refresh_token, cookieOpts);
  }

  response.cookies.delete("ng_passkey_challenge");
  return response;
}
