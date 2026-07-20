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

  const { credential } = verification.registrationInfo;
  const stored = JSON.stringify({
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64"),
    counter: credential.counter,
    transports: body.response.response?.transports || [],
  });

  // Store both the full credential JSON and the extracted credential ID
  // for O(log N) lookup during login. Uses raw SQL to avoid Prisma client
  // type issues on Vercel's cached builds.
  await db.$executeRaw`
    UPDATE accounts
    SET passkey_credential = ${stored},
        passkey_credential_id = ${credential.id}
    WHERE id = ${account.id}
  `;

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
