import { NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { checkRateLimit } from "@/lib/api";

// POST /api/auth/passkey/login-options
// Returns WebAuthn authentication options (userless discoverable credentials).
export async function POST(req: Request) {
  const rl = await checkRateLimit(
    req as unknown as import("next/server").NextRequest,
    "login",
  );
  if (rl) return rl;

  const rpID = process.env.NEXT_PUBLIC_APP_URL
    ? new URL(process.env.NEXT_PUBLIC_APP_URL).hostname
    : "localhost";

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
    maxAge: 120,
  });
  return response;
}
