import { NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { requireAuth } from "@/lib/api";

// POST /api/auth/passkey/register-options
// Returns WebAuthn registration options for the logged-in user.
export async function POST() {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  const rpID = process.env.NEXT_PUBLIC_APP_URL
    ? new URL(process.env.NEXT_PUBLIC_APP_URL).hostname
    : "localhost";
  const rpName = rpID === "localhost" ? "Nexus Gate (dev)" : "Nexus Gate";

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: Buffer.from(account.id, "utf-8"),
    userName: account.email,
    userDisplayName: account.fullName,
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  const response = NextResponse.json(options);
  response.cookies.set("ng_passkey_challenge", options.challenge, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 120,
  });
  return response;
}
