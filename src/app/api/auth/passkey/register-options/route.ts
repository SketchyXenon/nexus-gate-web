import { NextRequest, NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { requireAuth, checkRateLimitByKey } from "@/lib/api";
import { getWebAuthnContext } from "@/lib/webauthn-context";

// POST /api/auth/passkey/register-options
// Returns WebAuthn registration options for the logged-in user.
//
// HYBRID / CROSS-DEVICE DESIGN (per 06-security-architecture.md §2):
//   - residentKey: "preferred" — allows sync fabric (iCloud Keychain / Google
//     Password Manager / 1Password) so a passkey registered on a phone is
//     available on the user's PC/tablet without re-registration. This is the
//     primary mechanism for "works on every device without inconvenience."
//   - userVerification: "required" — a passkey without UV is only a "something
//     you have" factor. UV (biometric/PIN) makes it "have + are", and
//     register-verify rejects registrations where UV did not occur.
//   - authenticatorAttachment is intentionally omitted so the platform
//     authenticator (Face ID / Windows Hello) AND cross-device (scan QR with
//     phone) flows are both offered by the browser's native sheet.
export async function POST(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  // Rate limit passkey registration (10/min). Registration creates a
  // persistent credential row; an attacker with a stolen session could
  // otherwise register many passkeys. Fails CLOSED on limiter error.
  const rl = await checkRateLimitByKey(account.id, "passkeyRegister");
  if (rl) return rl;

  const { rpID } = getWebAuthnContext(req);
  const rpName = rpID === "localhost" ? "Nexus Gate (dev)" : "Nexus Gate";

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: Buffer.from(account.id, "utf-8"),
    userName: account.email,
    userDisplayName: account.fullName,
    authenticatorSelection: {
      // "preferred" lets the sync fabric (iCloud Keychain, Google Password
      // Manager) propagate the credential to the user's other devices — the
      // hybrid "register once, use everywhere" model. "required" would force
      // a roaming authenticator (USB key); "discouraged" keeps it device-local
      // (defeats cross-device use). "preferred" is the right default.
      residentKey: "preferred",
      // REQUIRED (not "preferred"): a UV-less credential is only a possession
      // factor. register-verify also enforces userVerified === true.
      userVerification: "required",
    },
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
