import { NextRequest, NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { checkRateLimit } from "@/lib/api";
import { getWebAuthnContext } from "@/lib/webauthn-context";

// POST /api/auth/passkey/login-options
// Returns WebAuthn authentication options (userless discoverable credentials).
//
// HYBRID / CROSS-DEVICE DESIGN:
//   - Discoverable credentials (allowCredentials: []) so the browser's native
//     sheet shows ALL passkeys for this RP across the user's sync fabric — a
//     passkey created on the phone is usable to sign in on the PC via the
//     cross-device (QR) flow, and vice versa. No "which account" prompt.
//   - userVerification: "required" — login-verify rejects assertions where UV
//     did not occur, so this matches registration. A "preferred" here would
//     let an attacker bypass UV on authenticators that downgrade silently.
export async function POST(req: NextRequest) {
  // passkeyOptions is lenient (30/min per-IP): this endpoint only returns
  // challenge options, no crypto. The expensive verify endpoint is tighter.
  const rl = await checkRateLimit(req, "passkeyOptions");
  if (rl) return rl;

  const { rpID } = getWebAuthnContext(req);

  const options = await generateAuthenticationOptions({
    rpID,
    timeout: 60000,
    // REQUIRED: matches registration. A passkey is a possession+biometric
    // factor; "preferred" silently degrades to possession-only on some
    // authenticators, weakening the factor.
    userVerification: "required",
    // Empty allowCredentials = discoverable credential login. The browser
    // shows all passkeys for this RP; the cross-device (phone-as-authenticator)
    // flow is offered automatically when the platform authenticator lacks one.
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
