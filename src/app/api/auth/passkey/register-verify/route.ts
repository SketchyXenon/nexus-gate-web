// Allow up to 15s for WebAuthn crypto verification.
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { db } from "@/lib/db";
import { requireAuth, checkRateLimitByKey } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getWebAuthnContext } from "@/lib/webauthn-context";

// POST /api/auth/passkey/register-verify
// Verifies the WebAuthn registration response and stores the credential.
export async function POST(req: NextRequest) {
  // Helper: delete the challenge cookie on any failure path (single-use).
  const failWithCookieDelete = (body: object, status: number) => {
    const resp = NextResponse.json(body, { status });
    resp.cookies.delete("ng_passkey_challenge");
    return resp;
  };

  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  // Rate limit passkey registration verification (10/min). Verification
  // does Ed25519 crypto + a DB write to store the credential. Mirrors the
  // register-options limit. Fails CLOSED on limiter error.
  const rl = await checkRateLimitByKey(account.id, "passkeyRegister");
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
  if (!body?.response) {
    return failWithCookieDelete(
      { error: "Missing registration response.", code: "BAD_REQUEST" },
      400,
    );
  }

  const { rpID, expectedOrigin } = getWebAuthnContext(req);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin,
      expectedRPID: rpID,
    });
  } catch (e) {
    console.error(
      "[passkey/register-verify] verification error:",
      e instanceof Error ? e.message : e,
    );
    return failWithCookieDelete(
      { error: "Passkey registration failed.", code: "VERIFICATION_FAILED" },
      400,
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    return failWithCookieDelete(
      { error: "Passkey registration failed.", code: "VERIFICATION_FAILED" },
      400,
    );
  }

  // SECURITY: require user verification. A passkey without UV is just a
  // "something you have" factor - anyone with physical access to the device
  // could sign in. UV (biometric/PIN) makes it "something you have + are".
  // Reject if the authenticator did not verify the user during attestation.
  if (!verification.registrationInfo.userVerified) {
    return failWithCookieDelete(
      {
        error:
          "User verification is required. Enable biometric or PIN unlock on your device and try again.",
        code: "USER_VERIFICATION_REQUIRED",
      },
      400,
    );
  }

  const { credential } = verification.registrationInfo;

  const stored = JSON.stringify({
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64"),
    counter: credential.counter,
    // Transports are a browser hint for future login prompts (not
    // cryptographically verified) - taken from the attestation response.
    transports: body.response.response?.transports || [],
  });

  // SECURITY: atomic credential-reuse rejection + store in a SINGLE
  // conditional UPDATE. The WHERE clause guards against TOCTOU races where
  // two concurrent registrations both pass a separate reuse SELECT and both
  // write the same credential_id. The `NOT EXISTS` subquery makes the DB
  // the single source of truth: if another account already holds this
  // credential_id, the UPDATE affects 0 rows. The @unique constraint on
  // passkey_credential_id (schema) is the final backstop. rowcount==0 here
  // means either reuse (credential belongs to another account) or the
  // account row vanished (concurrent delete) - both are safe rejects.
  // Physical column names are snake_case (TiDB/Postgres via @map) — the
  // production source of truth. Parameterized via Prisma tagged-template
  // literals (06-security-architecture.md §5).
  const result = await db.$executeRaw`
    UPDATE accounts
    SET passkey_credential = ${stored},
        passkey_credential_id = ${credential.id}
    WHERE id = ${account.id}
      AND NOT EXISTS (
        SELECT 1 FROM accounts
        WHERE passkey_credential_id = ${credential.id}
          AND id <> ${account.id}
      )
  `;
  if (result === 0) {
    await audit({
      actorId: account.id,
      action: "auth.passkey_register_reuse_blocked",
      targetType: "Account",
      metadata: { credentialId: credential.id },
      req,
    }).catch(() => {});
    return failWithCookieDelete(
      {
        error:
          "This passkey is already registered to another account. Use a different passkey.",
        code: "CREDENTIAL_REUSE",
      },
      409,
    );
  }

  await audit({
    actorId: account.id,
    action: "auth.passkey_registered",
    targetType: "Account",
    targetId: account.id,
    req,
  }).catch(() => {});

  const response = NextResponse.json({
    ok: true,
    message: "Passkey registered.",
  });
  response.cookies.delete("ng_passkey_challenge");
  return response;
}
