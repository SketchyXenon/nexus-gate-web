// Allow up to 10s for the HMAC + response.
export const maxDuration = 10;

import { NextRequest, NextResponse } from "next/server";
import { createHmac, randomBytes } from "crypto";
import { requireAuth } from "@/lib/api";

// GET /api/ably/token?eventId=123
// Issues a short-lived Ably TokenRequest with SUBSCRIBE-ONLY capability,
// scoped to a SINGLE event channel. The client never receives the full
// server key (which can publish); it gets a signed token that only allows
// subscribing to the specific event:N channel requested.
//
// This closes the PII leak where a wildcard event:* capability let any
// user subscribe to any event's real-time attendance (including events
// for other programs/sections).
export async function GET(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;

  const serverKey = process.env.ABLY_SERVER_KEY;
  if (!serverKey) {
    // Log with the env var name so this is obvious in Vercel function logs.
    // The 503 the client sees is correct (realtime is off), but operators
    // need to know WHY it's off without digging into the source.
    console.error(
      "[ably/token] 503 REALTIME_NOT_CONFIGURED: ABLY_SERVER_KEY env var is not set. " +
        "Get it from https://ably.com/dashboard -> your app -> API Keys " +
        "(format: keyName.keySecret). Add it to your Vercel project environment variables.",
    );
    return NextResponse.json(
      {
        error: "Realtime is not configured.",
        code: "REALTIME_NOT_CONFIGURED",
        hint: "ABLY_SERVER_KEY is missing on the server. Live attendance will fall back to polling.",
      },
      { status: 503 },
    );
  }

  // Parse and validate eventId from the query string.
  const eventIdParam = req.nextUrl.searchParams.get("eventId");
  const eventId = Number(eventIdParam);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return NextResponse.json(
      { error: "Valid eventId is required.", code: "BAD_REQUEST" },
      { status: 400 },
    );
  }

  // Server key format: "keyName.keySecret"
  const [keyName, keySecret] = serverKey.split(".");
  if (!keyName || !keySecret) {
    console.error(
      "[ably/token] ABLY_SERVER_KEY is malformed (expected keyName.keySecret)",
    );
    return NextResponse.json(
      { error: "Realtime misconfiguration.", code: "REALTIME_MISCONFIGURED" },
      { status: 500 },
    );
  }

  // Token params: 1-hour TTL, subscribe-only to the SPECIFIC event channel.
  const ttl = 3600 * 1000;
  const channel = `event:${eventId}`;
  const capability: Record<string, string[]> = {};
  capability[channel] = ["subscribe"];
  const timestamp = Date.now();
  const nonce = randomBytes(16).toString("hex");

  const capabilityJson = JSON.stringify(capability);
  const signedString = `${keyName}\n${ttl}\n${capabilityJson}\n${timestamp}\n${nonce}`;
  const mac = createHmac("sha256", keySecret)
    .update(signedString)
    .digest("hex");

  return NextResponse.json({
    keyName,
    ttl,
    capability,
    timestamp,
    nonce,
    mac,
  });
}
