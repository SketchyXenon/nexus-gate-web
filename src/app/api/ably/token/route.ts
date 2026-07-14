// Allow up to 10s for the HMAC + Ably validation.
export const maxDuration = 10;

import { NextRequest, NextResponse } from "next/server";
import { createHmac, randomBytes } from "crypto";
import { requireAuth } from "@/lib/api";

// GET /api/ably/token?eventId=123
// Issues a short-lived Ably TokenRequest with SUBSCRIBE-ONLY capability.
// Validates the key against Ably's REST API before returning the token.
// If the key is invalid (404), returns 503 so the client skips Ably.
export async function GET(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;

  const serverKey = process.env.ABLY_SERVER_KEY;
  if (!serverKey) {
    return NextResponse.json(
      { error: "Realtime is not configured.", code: "REALTIME_NOT_CONFIGURED" },
      { status: 503 },
    );
  }

  const eventIdParam = req.nextUrl.searchParams.get("eventId");
  const eventId = Number(eventIdParam);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return NextResponse.json(
      { error: "Valid eventId is required.", code: "BAD_REQUEST" },
      { status: 400 },
    );
  }

  const [keyName, keySecret] = serverKey.split(".");
  if (!keyName || !keySecret) {
    console.error("[ably/token] ABLY_SERVER_KEY is malformed");
    return NextResponse.json(
      { error: "Realtime misconfiguration.", code: "REALTIME_MISCONFIGURED" },
      { status: 500 },
    );
  }

  // Validate the key against Ably's REST API. This prevents returning
  // a signed token for a non-existent app, which would cause the Ably
  // SDK to retry indefinitely on the client.
  try {
    const validateRes = await fetch(`https://rest.ably.io/keys/${keyName}`, {
      signal: AbortSignal.timeout(3000),
      headers: {
        Authorization: `Basic ${Buffer.from(serverKey).toString("base64")}`,
      },
    });
    if (!validateRes.ok) {
      console.error(
        `[ably/token] Key validation failed: ${validateRes.status}`,
      );
      return NextResponse.json(
        { error: "Realtime key is invalid.", code: "REALTIME_KEY_INVALID" },
        { status: 503 },
      );
    }
  } catch (e) {
    // Network error validating — allow the token (non-fatal).
    console.warn("[ably/token] Key validation skipped (network error):", e);
  }

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
