import { NextRequest, NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { db } from "@/lib/db";
import { requireAuth, badRequest } from "@/lib/api";
import { audit } from "@/lib/audit";

// POST /api/auth/passkey/register-verify
// Verifies the WebAuthn registration response and stores the credential.
export async function POST(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  const challenge = req.cookies.get("ng_passkey_challenge")?.value;
  if (!challenge) {
    return badRequest(
      "Challenge expired. Please try again.",
      "CHALLENGE_EXPIRED",
    );
  }

  const body = await req.json().catch(() => null);
  if (!body?.response) {
    return badRequest("Missing registration response.", "BAD_REQUEST");
  }

  const rpID = process.env.NEXT_PUBLIC_APP_URL
    ? new URL(process.env.NEXT_PUBLIC_APP_URL).hostname
    : "localhost";
  const expectedOrigin =
    process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin,
      expectedRPID: rpID,
    });
  } catch (e) {
    return badRequest("Passkey registration failed.", "VERIFICATION_FAILED");
  }

  if (!verification.verified || !verification.registrationInfo) {
    return badRequest("Passkey registration failed.", "VERIFICATION_FAILED");
  }

  const { credential } = verification.registrationInfo;
  const stored = JSON.stringify({
    id: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: body.response.transports || [],
  });

  await db.account.update({
    where: { id: account.id },
    data: { passkeyCredential: stored },
  });

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
