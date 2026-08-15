// Allow up to 15s for crypto verification + Supabase session establishment.
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { db } from "@/lib/db";
import { checkRateLimit, checkRateLimitByKey } from "@/lib/api";
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
// Uses admin.generateLink to get a magic link, extracts the hashed_token,
// and consumes it via verifyOtp to establish a session.
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

  // Per-IP checkpoint (passkeyVerify: 10/min). More lenient than the old
  // login preset (5/min) so a NAT'd campus doesn't lock out after 5 attempts
  // from different students. The per-account checkpoint below is the real
  // brute-force defense.
  const ipRl = await checkRateLimit(req, "passkeyVerify");
  if (ipRl) return ipRl;

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
  // type issues on Vercel's cached builds.
  // Note: is_deactivated is BOOLEAN. Postgres pg driver returns true/false;
  // MySQL/TiDB mysql2 driver returns 0/1 (number). We normalize to boolean
  // below so the downstream truthiness check is unambiguous on both.
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
      isDeactivated: number | boolean | null;
    }>
  >`
    SELECT id, email, full_name AS fullName, role, status,
           student_id AS studentId, program, section,
           supabase_auth_uid AS supabaseAuthUid,
           passkey_credential AS passkeyCredential,
           is_deactivated AS isDeactivated
    FROM accounts
    WHERE passkey_credential_id = ${credentialId}
    LIMIT 1
  `;
  // Normalize isDeactivated to a real boolean (Postgres returns boolean,
  // MySQL/TiDB returns 0/1). Map undefined/null to false for type safety.
  for (const r of rows) {
    r.isDeactivated = Boolean(r.isDeactivated);
  }
  const account = rows[0] ?? null;

  // Per-account checkpoint (user_id rate limit): now that we know which
  // account this credential belongs to, throttle by account ID. This stops
  // an attacker with many IPs from hammering one credential.
  if (account) {
    const acctRl = await checkRateLimitByKey(account.id, "passkeyAccount");
    if (acctRl)
      return failWithCookieDelete(
        {
          error: "Too many passkey attempts. Please slow down.",
          code: "RATE_LIMITED",
        },
        429,
      );
  }

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
          // SECURITY: require user verification at login too (matches
          // registration). login-options sets userVerification: "required",
          // and we double-check the authenticator actually performed UV. A
          // "preferred" downgrade or a tampered authenticator that reports
          // verified=true without UV must not produce a session.
          if (!verification.authenticationInfo?.userVerified) {
            console.warn(
              "[passkey/login-verify] rejecting assertion without user verification for account",
              account.id,
            );
          } else {
            verifiedAccount = account;
            stored.counter = verification.authenticationInfo.newCounter;
            await db.account.update({
              where: { id: account.id },
              data: { passkeyCredential: JSON.stringify(stored) },
            });
          }
        }
      } else {
        console.warn(
          "[passkey/login-verify] stored credential missing id or publicKey for account",
          account.id,
        );
      }
    } catch (e) {
      // Log the ACTUAL error so operators can diagnose RP ID / origin
      // mismatches, challenge mismatches, etc. Previously swallowed silently.
      console.error(
        "[passkey/login-verify] verification threw for account",
        account.id,
        ":",
        e instanceof Error ? `${e.name}: ${e.message}` : e,
      );
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
  // Deactivated (soft-deleted) accounts must not authenticate via passkey.
  // Deactivation keeps the passkey credential row, so without this check a
  // deactivated user could bypass deactivation by signing in with a passkey.
  // Same bug class as the magic-link/callback deactivation bypass.
  if (
    verifiedAccount.isDeactivated ||
    verifiedAccount.status === "DEACTIVATED"
  ) {
    return failWithCookieDelete(
      { error: "Passkey verification failed.", code: "VERIFICATION_FAILED" },
      400,
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

  // Activate pending accounts BEFORE establishing the session, so the
  // session is for an ACTIVE account (not a pending one).
  if (verifiedAccount.status === "PENDING_VERIFICATION") {
    await db.account.update({
      where: { id: verifiedAccount.id },
      data: { status: "ACTIVE" },
    });
    (verifiedAccount as { status: string }).status = "ACTIVE";
  }

  // Establish a Supabase session for the verified user.
  // Strategy: use admin.generateLink to get a magic link, then use the
  // ANON client's verifyOtp with the hashed_token. The anon client (not
  // admin) ensures the session cookie is set via @supabase/ssr.
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

  const hashedToken = linkData.properties?.hashed_token || "";
  if (!hashedToken) {
    console.error("[passkey] no hashed_token in linkData properties");
    return failWithCookieDelete(
      { error: "Could not establish session.", code: "SESSION_FAILED" },
      500,
    );
  }

  // Reset failed-login counters and stamp lastLoginAt now that the
  // identity is verified and the account is active.
  await db.account.update({
    where: { id: verifiedAccount.id },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    },
  });

  // Use the ANON (cookie-based) client to verify the OTP. This sets the
  // session cookies via @supabase/ssr's setAll callback.
  const anonClient = await createSupabaseServerClient();
  const { data: sessionData, error: sessionError } =
    await anonClient.auth.verifyOtp({
      token_hash: hashedToken,
      type: "magiclink",
    });

  let session = sessionData?.session;
  if (sessionError || !session) {
    // Anon client may fail (PKCE state mismatch). Fall back to the admin
    // client to obtain a session, then persist it through the SSR anon
    // client via setSession so the session cookie is written by @supabase/ssr
    // (setAll) - never via custom-named cookies.
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
    session = adminSession.session;
    const { error: persistError } = await anonClient.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    if (persistError) {
      console.error("[passkey] setSession failed:", persistError.message);
    }
  }

  await audit({
    actorId: verifiedAccount.id,
    action: "auth.passkey_login",
    targetType: "Account",
    targetId: verifiedAccount.id,
    req,
  }).catch(() => {});

  // Single cookie-set path (was previously duplicated across two branches).
  // Session cookies are set by @supabase/ssr via the anon client's verifyOtp
  // (createSupabaseServerClient setAll callback) - the SAME mechanism the
  // login route relies on. Do NOT set custom sb-access-token/sb-refresh-token
  // cookies here: those names are not read by @supabase/ssr (which uses the
  // sb-<project-ref>-auth-token chunked cookie), so they would orphan past
  // logout (signOut only clears the SSR-managed cookie) and linger up to 7
  // days - a real session-fixation/credential-lifecycle risk.
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
  response.cookies.delete("ng_passkey_challenge");
  return response;
}
