import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, parseBody } from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

// ====================================================================
// Passkey Registration
// --------------------------------------------------------------------
// Step 1: POST /api/auth/passkey/register (no body) → returns options
// Step 2: POST /api/auth/passkey/register (body = credential) → verifies
//
// Passkeys are stored as a JSON string in the account's notificationKeys
// field (reused — we don't need a separate column for this MVP).
// In production, you'd use a separate PasskeyCredential table.
// ====================================================================

const RP_ID = process.env.NEXT_PUBLIC_APP_URL
  ? new URL(process.env.NEXT_PUBLIC_APP_URL).hostname
  : "localhost";
const RP_NAME = "Nexus Gate";

export async function POST(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  const body = await parseBody(req) as Record<string, unknown> | null;

  // ---- Step 1: Generate registration options ----
  if (!body || !body.credential) {
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: account.email,
      userDisplayName: account.fullName,
      timeout: 60000,
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });

    // Store the challenge in the account's notificationKeys field temporarily
    // (In production, use a separate challenge table or Redis)
    await db.account.update({
      where: { id: account.id },
      data: { passkeyCredential: JSON.stringify({ passkeyChallenge: options.challenge }) },
    });

    return NextResponse.json(options);
  }

  // ---- Step 2: Verify registration response ----
  const accountWithChallenge = await db.account.findUnique({
    where: { id: account.id },
    select: { passkeyCredential: true },
  });

  let expectedChallenge = "";
  try {
    const stored = JSON.parse(accountWithChallenge?.passkeyCredential || "{}");
    expectedChallenge = stored.passkeyChallenge || "";
  } catch {
    expectedChallenge = "";
  }

  try {
    const verification = await verifyRegistrationResponse({
      response: body.credential as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
      expectedRPID: RP_ID,
    });

    if (verification.verified && verification.registrationInfo) {
      // Store the credential (reusing notificationKeys field for MVP)
      const existing = JSON.parse(accountWithChallenge?.passkeyCredential || "{}");
      existing.passkeyCredential = JSON.stringify(verification.registrationInfo.credential);
      delete existing.passkeyChallenge;

      await db.account.update({
        where: { id: account.id },
        data: { passkeyCredential: JSON.stringify(existing) },
      });

      await audit({
        actorId: account.id,
        action: "auth.passkey_registered",
        targetType: "Account",
        targetId: account.id,
        req,
      });

      return NextResponse.json({ ok: true, message: "Passkey registered successfully." });
    }

    return NextResponse.json({ error: "Passkey verification failed." }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: `Passkey registration failed: ${e instanceof Error ? e.message : "Unknown error"}` },
      { status: 400 }
    );
  }
}
