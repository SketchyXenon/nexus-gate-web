import { NextRequest, NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { requireAuth, checkRateLimitByKey } from "@/lib/api";
import { getWebAuthnContext } from "@/lib/webauthn-context";

// POST /api/auth/passkey/register-options
// Returns WebAuthn registration options for the logged-in user.
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
      residentKey: "preferred",
      userVerification: "preferred",
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
