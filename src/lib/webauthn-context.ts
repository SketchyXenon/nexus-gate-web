import type { NextRequest } from "next/server";

export function getWebAuthnContext(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const hostname = req.nextUrl.hostname;

  return {
    expectedOrigin: origin,
    rpID: hostname,
  };
}
