// Allow up to 10s for the token request signing.
export const maxDuration = 10;

import { NextRequest, NextResponse } from "next/server";
import Ably from "ably";
import { db } from "@/lib/db";
import { forbidden, requireAuth } from "@/lib/api";

// GET /api/ably/token?eventId=123
// Issues a short-lived Ably TokenRequest with SUBSCRIBE-ONLY capability,
// scoped to a SINGLE event channel. The client never receives the full
// server key (which can publish); it gets a signed token request that
// only allows subscribing to the specific event:N channel requested.
//
// Uses the Ably SDK's auth.createTokenRequest() for signing. This is the
// officially recommended server-side approach and guarantees a spec-
// compliant TokenRequest (correct key parsing, canonicalization, HMAC).
// Hand-rolling the HMAC caused multiple spec-mismatch bugs (split char,
// capability type, mac canonical form); the SDK eliminates that class.
export async function GET(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;

  const serverKey = process.env.ABLY_SERVER_KEY;
  if (!serverKey) {
    console.error(
      "[ably/token] 503 REALTIME_NOT_CONFIGURED: ABLY_SERVER_KEY env var is not set. " +
        "Get it from https://ably.com/dashboard -> your app -> API Keys " +
        "(format: keyName:keySecret). Add it to your Vercel project environment variables.",
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

  // Validate the key format BEFORE constructing the client, so we return
  // a clear 500 instead of an opaque SDK error. Ably keys are
  // "keyName:keySecret" where keyName is "appId.keyId" (colon-separated).
  const colonIdx = serverKey.indexOf(":");
  if (colonIdx === -1 || !serverKey.slice(0, colonIdx).includes(".")) {
    console.error(
      "[ably/token] ABLY_SERVER_KEY is malformed. Expected format: " +
        "keyName:keySecret (e.g. appId.keyId:secret). " +
        "Copy the FULL key from the Ably dashboard.",
    );
    return NextResponse.json(
      { error: "Realtime misconfiguration.", code: "REALTIME_MISCONFIGURED" },
      { status: 500 },
    );
  }

  // Parse and validate eventId from the query string.
  const eventIdParam = req.nextUrl.searchParams.get("eventId");
  const eventId = Number(eventIdParam);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return NextResponse.json(
      {
        error: "Valid eventId is required.",
        code: "BAD_REQUEST",
        hint: `Received eventId=${JSON.stringify(eventIdParam)}. Must be a positive integer (e.g. /api/ably/token?eventId=17).`,
      },
      { status: 400 },
    );
  }

  // ---- BOLA defense: verify the caller may see this event's channel ----
  // The event:N channel broadcasts attending students' full name, student ID,
  // program, and section in real time. Without this check, any authenticated
  // USER could subscribe to ANY event's channel and harvest other students'
  // PII. We apply the SAME visibility rule as GET /api/events:
  //   - ADMIN: sees all events.
  //   - ORGANIZER: open-to-all, OR their program (any section), OR exact match.
  //   - USER: open-to-all, OR exact program + section match (strict).
  // A 403 (not 404) is returned because the eventId is not a secret — it's a
  // sequential integer the client already has from the events list. Hiding
  // existence via 404 would be security-through-obscurity; the visibility
  // rule is the real control.
  const { account } = res;
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: {
      status: true,
      targetProgram: true,
      targetSection: true,
      ownerId: true,
    },
  });
  if (!event || event.status !== "active") {
    return forbidden("This event is not available.");
  }
  if (account.role !== "ADMIN") {
    const isOpenToAll = !event.targetProgram && !event.targetSection;
    const isExactMatch =
      !!event.targetProgram &&
      !!event.targetSection &&
      event.targetProgram === account.program &&
      event.targetSection === account.section;
    const isOrganizerProgramMatch =
      account.role === "ORGANIZER" &&
      !!event.targetProgram &&
      event.targetProgram === account.program;
    // Organizers also own their events (can always see their own channel).
    const isOwner = event.ownerId === account.id;
    if (!isOpenToAll && !isExactMatch && !isOrganizerProgramMatch && !isOwner) {
      return forbidden("You are not eligible to view this event.");
    }
  }

  // Construct the Ably REST client with the server key. autoConnect:false
  // prevents the SDK from opening a WebSocket (we only need REST for
  // token signing, not realtime).
  const rest = new Ably.Rest({ key: serverKey, autoConnect: false });

  try {
    // createTokenRequest handles: key parsing, capability canonicalization,
    // HMAC-SHA256 signing, nonce generation, and timestamp. Returns a
    // TokenRequest object matching Ably's REST API spec exactly.
    const tokenRequest = await rest.auth.createTokenRequest({
      capability: { [`event:${eventId}`]: ["subscribe"] },
      ttl: 3600 * 1000,
    });

    return NextResponse.json(tokenRequest);
  } catch (e) {
    console.error(
      "[ably/token] createTokenRequest failed:",
      e instanceof Error ? `${e.name}: ${e.message}` : e,
    );
    return NextResponse.json(
      {
        error: "Failed to sign realtime token.",
        code: "TOKEN_SIGN_FAILED",
      },
      { status: 500 },
    );
  }
}
