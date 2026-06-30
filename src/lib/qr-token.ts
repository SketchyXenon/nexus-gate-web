// ====================================================================
// Nexus Gate — Cryptographic Dynamic Token (v8 — Tier 1 + Tier 2)
// --------------------------------------------------------------------
// Dual-layer anti-cheating:
//
//   Layer 1 (Rotating HMAC): 15-second time blocks with ±1 tolerance.
//     Screenshots expire within 15 seconds. Token format:
//       <eventId>.<timeBlock>.<hmac>
//
//   Layer 2 (Multi-Frame Liveness): each block is divided into
//     SUB_FRAME_MS (500ms) sub-frames. The QR refreshes at 2 FPS,
//     and the scanner must capture MIN_SUB_FRAMES (3) consecutive
//     sub-frames to form a valid certificate. A single photograph
//     captures only 1 sub-frame → rejected. Token format:
//       <eventId>.<timeBlock>.<subFrame>.<subHmac>
//
// The v8 format (4 parts) is the default. The legacy v5 format
// (3 parts) is still accepted for backward compatibility with
// existing attendance records, but new scans require v8.
// ====================================================================

import { hmacSha256 } from "@/lib/auth";
import { timingSafeCompareHex } from "@/lib/timing-safe";

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

/**
 * Compute the sub-frame index within the current time block.
 * Returns 0 to SUB_FRAMES_PER_BLOCK - 1.
 */
export function currentSubFrame(now: number = Date.now()): number {
  return Math.floor((now % TOKEN_WINDOW_MS) / SUB_FRAME_MS);
}

/**
 * Milliseconds until the next sub-frame boundary.
 * Used by the projector to schedule QR refreshes.
 */
export function msUntilNextSubFrame(now: number = Date.now()): number {
  return SUB_FRAME_MS - (now % SUB_FRAME_MS);
}

// ---- Layer 1 HMAC (block-level) ----
export function computeTokenHmac(
  eventSecret: string,
  eventId: number,
  timeBlock: number
): string {
  return hmacSha256(eventSecret, `${eventId}:${timeBlock}`);
}

// ---- Layer 2 HMAC (sub-frame-level) ----
export function computeSubFrameHmac(
  eventSecret: string,
  eventId: number,
  timeBlock: number,
  subFrame: number
): string {
  return hmacSha256(eventSecret, `${eventId}:${timeBlock}:${subFrame}`);
}

// ====================================================================
// QR Payload Generation (v8 — with sub-frame)
// ====================================================================

export interface ProjectedToken {
  payload: string;
  timeBlock: number;
  subFrame: number;
  expiresInMs: number;
  expiresSubFrameInMs: number;
}

/**
 * Generate the v8 QR payload for the current time block + sub-frame.
 * The payload includes the sub-frame index and a sub-frame-specific HMAC.
 */
export function generateQrPayload(
  eventId: number,
  eventSecret: string,
  now: number = Date.now()
): ProjectedToken {
  const timeBlock = currentTimeBlock(now);
  const subFrame = currentSubFrame(now);
  const hmac = computeSubFrameHmac(eventSecret, eventId, timeBlock, subFrame);
  return {
    payload: `${eventId}.${timeBlock}.${subFrame}.${hmac}`,
    timeBlock,
    subFrame,
    expiresInMs: msUntilNextBlock(now),
    expiresSubFrameInMs: msUntilNextSubFrame(now),
  };
}

// ====================================================================
// QR Payload Validation
// ====================================================================

export type ValidationReason =
  | "malformed"
  | "expired"
  | "invalid_signature"
  | "future_block"
  | "invalid_subframe"
  | "insufficient_subframes";

export interface ValidationResult {
  ok: boolean;
  reason?: ValidationReason;
  eventId?: number;
  timeBlock?: number;
  subFrame?: number;
  drift?: number;
  format?: "v5" | "v8"; // v5 = legacy 3-part, v8 = 4-part with sub-frame
}

/**
 * Validate a raw QR payload string.
 *
 * Supports both formats:
 *   v8 (4 parts): <eventId>.<timeBlock>.<subFrame>.<subHmac>
 *   v5 (3 parts): <eventId>.<timeBlock>.<hmac>  (legacy, backward compat)
 *
 * For v8, the sub-frame HMAC is verified against the eventSecret.
 * For v5, the block-level HMAC is verified (no sub-frame).
 */
export function validateQrPayload(
  raw: string,
  eventSecret: string,
  now: number = Date.now()
): ValidationResult {
  const parts = raw.split(".");
  if (parts.length !== 4 && parts.length !== 3) {
    return { ok: false, reason: "malformed" };
  }

  const eventIdNum = Number(parts[0]);
  const timeBlockNum = Number(parts[1]);

  if (!Number.isFinite(eventIdNum) || !Number.isFinite(timeBlockNum) || eventIdNum <= 0) {
    return { ok: false, reason: "malformed" };
  }

  const current = currentTimeBlock(now);
  const drift = timeBlockNum - current;

  if (drift > TOKEN_TOLERANCE) {
    return { ok: false, reason: "future_block", eventId: eventIdNum, timeBlock: timeBlockNum, drift };
  }
  if (drift < -TOKEN_TOLERANCE) {
    return { ok: false, reason: "expired", eventId: eventIdNum, timeBlock: timeBlockNum, drift };
  }

  // ---- v8 format: 4 parts with sub-frame ----
  if (parts.length === 4) {
    const subFrameNum = Number(parts[2]);
    const hmac = parts[3];

    if (!Number.isFinite(subFrameNum) || subFrameNum < 0 || subFrameNum >= SUB_FRAMES_PER_BLOCK) {
      return { ok: false, reason: "malformed", eventId: eventIdNum, timeBlock: timeBlockNum };
    }
    if (!hmac) return { ok: false, reason: "malformed" };

    const expected = computeSubFrameHmac(eventSecret, eventIdNum, timeBlockNum, subFrameNum);
    if (!timingSafeCompareHex(expected, hmac)) {
      return { ok: false, reason: "invalid_signature", eventId: eventIdNum, timeBlock: timeBlockNum, subFrame: subFrameNum, drift, format: "v8" };
    }

    return { ok: true, eventId: eventIdNum, timeBlock: timeBlockNum, subFrame: subFrameNum, drift, format: "v8" };
  }

  // ---- v5 format: 3 parts (legacy) ----
  const hmac = parts[2];
  if (!hmac) return { ok: false, reason: "malformed" };

  const expected = computeTokenHmac(eventSecret, eventIdNum, timeBlockNum);
  if (!timingSafeCompareHex(expected, hmac)) {
    return { ok: false, reason: "invalid_signature", eventId: eventIdNum, timeBlock: timeBlockNum, drift, format: "v5" };
  }

  return { ok: true, eventId: eventIdNum, timeBlock: timeBlockNum, drift, format: "v5" };
}

// ====================================================================
// Tier 2: Sub-frame liveness verification
// ====================================================================

/**
 * Verify that a set of captured sub-frames proves multi-frame liveness.
 *
 * Requirements:
 *   1. At least MIN_SUB_FRAMES (3) sub-frames captured.
 *   2. All sub-frames are within the SAME time block.
 *   3. The sub-frames are CONSECUTIVE (monotonically increasing by 1).
 *      This proves the scanner watched the QR change over time — a
 *      single photograph can only capture 1 sub-frame.
 *   4. Each sub-frame's HMAC is valid against the eventSecret.
 *
 * @param subFrames - array of { subFrame, hmac } captured by the scanner
 * @param eventSecret - the event's secret (for HMAC verification)
 * @param eventId - the event ID
 * @param timeBlock - the time block all sub-frames should belong to
 * @returns { ok: true } or { ok: false, reason }
 */
export function verifySubFrameLiveness(
  subFrames: Array<{ subFrame: number; hmac: string }>,
  eventSecret: string,
  eventId: number,
  timeBlock: number
): { ok: true } | { ok: false; reason: ValidationReason } {
  if (subFrames.length < MIN_SUB_FRAMES) {
    return { ok: false, reason: "insufficient_subframes" };
  }

  // Sort by sub-frame index
  const sorted = [...subFrames].sort((a, b) => a.subFrame - b.subFrame);

  // Check all are within valid range
  for (const sf of sorted) {
    if (sf.subFrame < 0 || sf.subFrame >= SUB_FRAMES_PER_BLOCK) {
      return { ok: false, reason: "invalid_subframe" };
    }
    const expected = computeSubFrameHmac(eventSecret, eventId, timeBlock, sf.subFrame);
    if (!timingSafeCompareHex(expected, sf.hmac)) {
      return { ok: false, reason: "invalid_signature" };
    }
  }

  // Check consecutive: each sub-frame must be exactly 1 more than the previous.
  // We allow skipping at most 1 sub-frame (camera might miss a frame at 2 FPS).
  for (let i = 1; i < sorted.length; i++) {
    const diff = sorted[i].subFrame - sorted[i - 1].subFrame;
    if (diff < 1 || diff > 2) {
      // Not consecutive (or too big a gap) — likely a fabricated set
      return { ok: false, reason: "invalid_subframe" };
    }
  }

  return { ok: true };
}
