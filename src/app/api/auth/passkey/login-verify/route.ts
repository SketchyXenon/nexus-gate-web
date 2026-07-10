// Allow up to 15s for crypto verification + Supabase session establishment.
export const maxDuration = 15;

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

function toFixedArrayBuffer(
  bytes: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const fixed = new Uint8Array(bytes.byteLength);
  fixed.set(bytes);
  return fixed;
}

function decodeStoredPublicKey(
  publicKey: unknown,
): Uint8Array<ArrayBuffer> | null {
  if (publicKey instanceof Uint8Array) return toFixedArrayBuffer(publicKey);
  if (typeof publicKey === "string" && publicKey.trim()) {
    try {
      return toFixedArrayBuffer(
        Uint8Array.from(Buffer.from(publicKey.trim(), "base64")),
      );
    } catch {
      try {
        const normalized = publicKey
          .trim()
          .replace(/-/g, "+")
          .replace(/_/g, "/");
        return toFixedArrayBuffer(
          Uint8Array.from(Buffer.from(normalized, "base64")),
        );
      } catch {
        return null;
      }
    }
  }
  if (Array.isArray(publicKey)) {
    return toFixedArrayBuffer(
      Uint8Array.from(publicKey.map((n) => Number(n) || 0)),
    );
  }
  if (publicKey && typeof publicKey === "object") {
    const entries = Object.entries(publicKey)
      .filter(([, value]) => typeof value === "number")
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, value]) => Number(value));
    if (entries.length > 0) {
      return toFixedArrayBuffer(Uint8Array.from(entries));
    }
  }
  return null;
}

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

  // O(log N) lookup: extract the credential ID from the assertion and find
  // the owning account via the indexed passkeyCredentialId column.
  // Previously this scanned ALL passkey holders and ran N crypto verifications.
  const assertion = body.assertion as AuthenticationResponseJSON;
  const credentialId = assertion?.id;
  if (!credentialId) {
    return failWithCookieDelete(
      { error: "Missing credential ID in assertion.", code: "BAD_REQUEST" },
      400,
    );
  }

  // O(log N) lookup: find the account by credential ID via the indexed
  // passkey_credential_id column. Uses raw SQL to avoid Prisma client
  // type issues on Vercel's cached builds (the column exists in the DB
  // and both Prisma schemas, but the generated client may be stale).
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      email: string;
      fullName: string;
      role: string;
      status: string;
      studentId: number | null;
      program: string | null;
      section: string | null;
      supabaseAuthUid: string | null;
      passkeyCredential: string | null;
    }>
  >`
    SELECT id, email, full_name as "fullName", role, status,
           student_id as "studentId", program, section,
           supabase_auth_uid as "supabaseAuthUid",
           passkey_credential as "passkeyCredential"
    FROM accounts
    WHERE passkey_credential_id = ${credentialId}
    LIMIT 1
  `;
  const account = rows[0] ?? null;

  let verifiedAccount: typeof account | null = null;
  if (account) {
    try {
      const stored = JSON.parse(account.passkeyCredential || "{}");
      const publicKey = decodeStoredPublicKey(stored.publicKey);
      if (stored.id && publicKey) {
        const verification = await verifyAuthenticationResponse({
          response: assertion,
          expectedChallenge: challenge,
          expectedOrigin,
          expectedRPID: rpID,
          credential: {
            id: stored.id,
            publicKey,
            counter: stored.counter,
            transports: stored.transports,
          },
        });
        if (verification.verified) {
          verifiedAccount = account;
          stored.counter = verification.authenticationInfo.newCounter;
          await db.account.update({
            where: { id: account.id },
            data: { passkeyCredential: JSON.stringify(stored) },
          });
        }
      }
    } catch {
      console.warn("[passkey/login-verify] verification threw for account");
    }
  }

  if (!verifiedAccount) {
    console.warn(
      "[passkey/login-verify] no matching passkey credential verified",
    );
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
