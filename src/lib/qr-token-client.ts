// ====================================================================
// Nexus Gate — Client-side Cryptographic Dynamic Token (v8)
// --------------------------------------------------------------------
// Mirrors src/lib/qr-token.ts (server) but uses the Web Crypto API
// (HMAC-SHA256) so the projector and scanner can compute/validate
// tokens fully in the browser (<0.1s).
//
// v8 format (4 parts): <eventId>.<timeBlock>.<subFrame>.<subHmac>
// v5 format (3 parts): <eventId>.<timeBlock>.<hmac>  (legacy)
// ====================================================================

export const TOKEN_WINDOW_MS = 15_000;
export const TOKEN_TOLERANCE = 1;

// ---- Tier 2: Multi-frame liveness ----
export const SUB_FRAME_MS = 500;
export const SUB_FRAMES_PER_BLOCK = Math.floor(TOKEN_WINDOW_MS / SUB_FRAME_MS); // 30
export const MIN_SUB_FRAMES = 3;

export function currentTimeBlock(now: number = Date.now()): number {
  return Math.floor(now / TOKEN_WINDOW_MS);
}

export function msUntilNextBlock(now: number = Date.now()): number {
  return TOKEN_WINDOW_MS - (now % TOKEN_WINDOW_MS);
}

export function currentSubFrame(now: number = Date.now()): number {
  return Math.floor((now % TOKEN_WINDOW_MS) / SUB_FRAME_MS);
}

export function msUntilNextSubFrame(now: number = Date.now()): number {
  return SUB_FRAME_MS - (now % SUB_FRAME_MS);
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function computeTokenHmac(
  eventSecret: string,
  eventId: number,
  timeBlock: number
): Promise<string> {
  return hmacSha256Hex(eventSecret, `${eventId}:${timeBlock}`);
}

export async function computeSubFrameHmac(
  eventSecret: string,
  eventId: number,
  timeBlock: number,
  subFrame: number
): Promise<string> {
  return hmacSha256Hex(eventSecret, `${eventId}:${timeBlock}:${subFrame}`);
}

export interface ProjectedToken {
  payload: string;
  timeBlock: number;
  subFrame: number;
  expiresInMs: number;
  expiresSubFrameInMs: number;
}

/**
 * Generate the v8 QR payload for the current time block + sub-frame.
 */
export async function generateQrPayload(
  eventId: number,
  eventSecret: string,
  now: number = Date.now()
): Promise<ProjectedToken> {
  const timeBlock = currentTimeBlock(now);
  const subFrame = currentSubFrame(now);
  const hmac = await computeSubFrameHmac(eventSecret, eventId, timeBlock, subFrame);
  return {
    payload: `${eventId}.${timeBlock}.${subFrame}.${hmac}`,
    timeBlock,
    subFrame,
    expiresInMs: msUntilNextBlock(now),
    expiresSubFrameInMs: msUntilNextSubFrame(now),
  };
}
