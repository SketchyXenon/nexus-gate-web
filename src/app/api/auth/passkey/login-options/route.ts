import { NextRequest, NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { checkRateLimit } from "@/lib/api";
import { getWebAuthnContext } from "@/lib/webauthn-context";

// POST /api/auth/passkey/login-options
// Returns WebAuthn authentication options (userless discoverable credentials).
export async function POST(req: NextRequest) {
  // passkeyOptions is lenient (30/min per-IP): this endpoint only returns
  // challenge options, no crypto. The expensive verify endpoint is tighter.
  const rl = await checkRateLimit(req, "passkeyOptions");
  if (rl) return rl;

  const { rpID } = getWebAuthnContext(req);

  const options = await generateAuthenticationOptions({
    rpID,
    timeout: 60000,
    userVerification: "preferred",
  });

  const response = NextResponse.json(options);
  response.cookies.set("ng_passkey_challenge", options.challenge, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 120,
  });
  return response;
}
