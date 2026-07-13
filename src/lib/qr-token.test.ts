import { describe, it, expect } from "vitest";
import {
  TOKEN_WINDOW_MS,
  SUB_FRAME_MS,
  SUB_FRAMES_PER_BLOCK,
  MIN_SUB_FRAMES,
  TOKEN_TOLERANCE,
  currentTimeBlock,
  currentSubFrame,
  msUntilNextSubFrame,
  msUntilNextBlock,
  computeTokenHmac,
  computeSubFrameHmac,
  generateQrPayload,
  validateQrPayload,
  verifySubFrameLiveness,
} from "./qr-token";

// ====================================================================
// Unit tests for the v8 QR token system (Tier 1 + Tier 2).
// ====================================================================

describe("constants", () => {
  it("TOKEN_WINDOW_MS is 15000 (15 seconds)", () => {
    expect(TOKEN_WINDOW_MS).toBe(15_000);
  });

  it("SUB_FRAME_MS is 500 (0.5 seconds)", () => {
    expect(SUB_FRAME_MS).toBe(500);
  });

  it("SUB_FRAMES_PER_BLOCK is 30", () => {
    expect(SUB_FRAMES_PER_BLOCK).toBe(30);
  });

  it("MIN_SUB_FRAMES is 3", () => {
    expect(MIN_SUB_FRAMES).toBe(3);
  });

  it("TOKEN_TOLERANCE is 1", () => {
    expect(TOKEN_TOLERANCE).toBe(1);
  });
});

describe("currentTimeBlock", () => {
  it("computes the correct time block", () => {
    expect(currentTimeBlock(0)).toBe(0);
    expect(currentTimeBlock(14999)).toBe(0);
    expect(currentTimeBlock(15000)).toBe(1);
    expect(currentTimeBlock(30000)).toBe(2);
  });
});

describe("currentSubFrame", () => {
  it("computes the correct sub-frame index", () => {
    expect(currentSubFrame(0)).toBe(0);
    expect(currentSubFrame(499)).toBe(0);
    expect(currentSubFrame(500)).toBe(1);
    expect(currentSubFrame(1000)).toBe(2);
    expect(currentSubFrame(14500)).toBe(29);
    expect(currentSubFrame(14999)).toBe(29);
  });

  it("wraps at the block boundary", () => {
    // Sub-frame 29 is the last in a block; 15000 starts a new block at sub-frame 0
    expect(currentSubFrame(14999)).toBe(29);
    expect(currentSubFrame(15000)).toBe(0);
  });
});

describe("msUntilNextSubFrame", () => {
  it("computes ms until the next sub-frame boundary", () => {
    expect(msUntilNextSubFrame(0)).toBe(500);
    expect(msUntilNextSubFrame(250)).toBe(250);
    expect(msUntilNextSubFrame(499)).toBe(1);
    expect(msUntilNextSubFrame(500)).toBe(500);
  });
});

describe("computeSubFrameHmac", () => {
  it("produces a deterministic HMAC for the same inputs", () => {
    const h1 = computeSubFrameHmac("secret", 1, 100, 0);
    const h2 = computeSubFrameHmac("secret", 1, 100, 0);
    expect(h1).toBe(h2);
  });

  it("produces DIFFERENT HMACs for different sub-frames", () => {
    const h0 = computeSubFrameHmac("secret", 1, 100, 0);
    const h1 = computeSubFrameHmac("secret", 1, 100, 1);
    const h2 = computeSubFrameHmac("secret", 1, 100, 2);
    expect(h0).not.toBe(h1);
    expect(h1).not.toBe(h2);
    expect(h0).not.toBe(h2);
  });

  it("produces DIFFERENT HMACs for different events", () => {
    const h1 = computeSubFrameHmac("secret", 1, 100, 0);
    const h2 = computeSubFrameHmac("secret", 2, 100, 0);
    expect(h1).not.toBe(h2);
  });

  it("produces a hex string", () => {
    const h = computeSubFrameHmac("secret", 1, 100, 0);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });
});

// ====================================================================
// generateQrPayload (v8 format)
// ====================================================================

describe("generateQrPayload", () => {
  it("generates a 4-part v8 payload", () => {
    const t = generateQrPayload(42, "secret", 1700000000000);
    const parts = t.payload.split(".");
    expect(parts.length).toBe(4);
    expect(Number(parts[0])).toBe(42); // eventId
    expect(Number(parts[1])).toBe(currentTimeBlock(1700000000000)); // timeBlock
    expect(Number(parts[2])).toBe(currentSubFrame(1700000000000)); // subFrame
    expect(parts[3]).toMatch(/^[0-9a-f]+$/); // hmac
  });

  it("includes the correct timeBlock and subFrame", () => {
    const now = 1700000012345;
    const t = generateQrPayload(42, "secret", now);
    expect(t.timeBlock).toBe(currentTimeBlock(now));
    expect(t.subFrame).toBe(currentSubFrame(now));
  });

  it("includes expiresInMs and expiresSubFrameInMs", () => {
    const now = 1700000000250; // 250ms into a sub-frame
    const t = generateQrPayload(42, "secret", now);
    expect(t.expiresSubFrameInMs).toBe(250); // 500 - 250
    expect(t.expiresInMs).toBeGreaterThan(0);
  });
});

// ====================================================================
// validateQrPayload (v8 + v5 backward compat)
// ====================================================================

describe("validateQrPayload — v8 format", () => {
  const secret = "test-secret";
  const eventId = 42;
  const now = 1700000000000;

  it("validates a freshly generated v8 token", () => {
    const t = generateQrPayload(eventId, secret, now);
    const result = validateQrPayload(t.payload, secret, now);
    expect(result.ok).toBe(true);
    expect(result.format).toBe("v8");
    expect(result.eventId).toBe(eventId);
    expect(result.subFrame).toBe(t.subFrame);
  });

  it("rejects a v8 token with a tampered sub-frame index", () => {
    const t = generateQrPayload(eventId, secret, now);
    const parts = t.payload.split(".");
    parts[2] = String(Number(parts[2]) + 1); // tamper sub-frame
    const tampered = parts.join(".");
    const result = validateQrPayload(tampered, secret, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  it("rejects a v8 token with a tampered HMAC", () => {
    const t = generateQrPayload(eventId, secret, now);
    const parts = t.payload.split(".");
    parts[3] = "a".repeat(64); // tamper HMAC
    const tampered = parts.join(".");
    const result = validateQrPayload(tampered, secret, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  it("rejects an expired v8 token (drift < -1)", () => {
    const oldNow = now - 2 * TOKEN_WINDOW_MS; // 2 blocks ago
    const t = generateQrPayload(eventId, secret, oldNow);
    const result = validateQrPayload(t.payload, secret, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("expired");
  });

  it("rejects a future v8 token (drift > 1)", () => {
    const futureNow = now + 2 * TOKEN_WINDOW_MS; // 2 blocks ahead
    const t = generateQrPayload(eventId, secret, futureNow);
    const result = validateQrPayload(t.payload, secret, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("future_block");
  });

  it("accepts a v8 token within the tolerance window (drift = -1)", () => {
    const recentNow = now - TOKEN_WINDOW_MS; // 1 block ago
    const t = generateQrPayload(eventId, secret, recentNow);
    const result = validateQrPayload(t.payload, secret, now);
    expect(result.ok).toBe(true);
  });
});

describe("validateQrPayload — v5 legacy format (backward compat)", () => {
  const secret = "test-secret";
  const eventId = 42;
  const now = 1700000000000;
  const block = currentTimeBlock(now);
  const hmac = computeTokenHmac(secret, eventId, block);
  const v5Token = `${eventId}.${block}.${hmac}`;

  it("validates a v5 legacy token", () => {
    const result = validateQrPayload(v5Token, secret, now);
    expect(result.ok).toBe(true);
    expect(result.format).toBe("v5");
    expect(result.eventId).toBe(eventId);
  });

  it("rejects a tampered v5 token", () => {
    const parts = v5Token.split(".");
    parts[2] = "b".repeat(64);
    const result = validateQrPayload(parts.join("."), secret, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });
});

describe("validateQrPayload — malformed", () => {
  it("rejects a token with only 2 parts", () => {
    const result = validateQrPayload("42.100", "secret");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("malformed");
  });

  it("rejects a token with 5 parts", () => {
    const result = validateQrPayload("42.100.5.abc.extra", "secret");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("malformed");
  });

  it("rejects a token with non-numeric eventId", () => {
    const result = validateQrPayload("abc.100.5.hmac", "secret");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("malformed");
  });

  it("rejects a token with eventId <= 0", () => {
    const result = validateQrPayload("0.100.5.hmac", "secret");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("malformed");
  });

  it("rejects a v8 token with out-of-range subFrame", () => {
    const t = generateQrPayload(42, "secret", now);
    const parts = t.payload.split(".");
    parts[2] = "30"; // SUB_FRAMES_PER_BLOCK = 30, so 30 is out of range
    const result = validateQrPayload(parts.join("."), "secret", now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("malformed");
  });

  const now = 1700000000000;
});

// ====================================================================
// verifySubFrameLiveness (Tier 2)
// ====================================================================

describe("verifySubFrameLiveness", () => {
  const secret = "test-secret";
  const eventId = 42;
  const timeBlock = 100;

  it("accepts 3 consecutive sub-frames with valid HMACs", () => {
    const subFrames = [0, 1, 2].map((sf) => ({
      subFrame: sf,
      hmac: computeSubFrameHmac(secret, eventId, timeBlock, sf),
    }));
    const result = verifySubFrameLiveness(subFrames, secret, eventId, timeBlock);
    expect(result.ok).toBe(true);
  });

  it("accepts 4+ consecutive sub-frames", () => {
    const subFrames = [5, 6, 7, 8].map((sf) => ({
      subFrame: sf,
      hmac: computeSubFrameHmac(secret, eventId, timeBlock, sf),
    }));
    const result = verifySubFrameLiveness(subFrames, secret, eventId, timeBlock);
    expect(result.ok).toBe(true);
  });

  it("accepts sub-frames with a gap of 2 (camera missed a frame)", () => {
    const subFrames = [0, 1, 3].map((sf) => ({
      subFrame: sf,
      hmac: computeSubFrameHmac(secret, eventId, timeBlock, sf),
    }));
    const result = verifySubFrameLiveness(subFrames, secret, eventId, timeBlock);
    expect(result.ok).toBe(true);
  });

  it("rejects fewer than MIN_SUB_FRAMES (3) sub-frames", () => {
    const subFrames = [0, 1].map((sf) => ({
      subFrame: sf,
      hmac: computeSubFrameHmac(secret, eventId, timeBlock, sf),
    }));
    const result = verifySubFrameLiveness(subFrames, secret, eventId, timeBlock);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("insufficient_subframes");
    }
  });

  it("rejects sub-frames with a gap > 2 (not consecutive)", () => {
    const subFrames = [0, 1, 5].map((sf) => ({
      subFrame: sf,
      hmac: computeSubFrameHmac(secret, eventId, timeBlock, sf),
    }));
    const result = verifySubFrameLiveness(subFrames, secret, eventId, timeBlock);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_subframe");
    }
  });

  it("rejects sub-frames with invalid HMACs", () => {
    const subFrames = [0, 1, 2].map((sf) => ({
      subFrame: sf,
      hmac: "invalid",
    }));
    const result = verifySubFrameLiveness(subFrames, secret, eventId, timeBlock);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_signature");
    }
  });

  it("rejects sub-frames with out-of-range indices", () => {
    const subFrames = [
      { subFrame: 30, hmac: "abc" }, // out of range (SUB_FRAMES_PER_BLOCK = 30)
      { subFrame: 0, hmac: computeSubFrameHmac(secret, eventId, timeBlock, 0) },
      { subFrame: 1, hmac: computeSubFrameHmac(secret, eventId, timeBlock, 1) },
    ];
    const result = verifySubFrameLiveness(subFrames, secret, eventId, timeBlock);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_subframe");
    }
  });

  it("handles unsorted sub-frames (sorts internally)", () => {
    const subFrames = [2, 0, 1].map((sf) => ({
      subFrame: sf,
      hmac: computeSubFrameHmac(secret, eventId, timeBlock, sf),
    }));
    const result = verifySubFrameLiveness(subFrames, secret, eventId, timeBlock);
    expect(result.ok).toBe(true);
  });

  // ---- Boundary-straddling scans (the bug from C2) ----
  // These cases were previously rejected because the function sorted by
  // subFrame index alone, breaking temporal order across block boundaries.

  it("accepts a boundary-straddling scan: [28,29 in N] + [0 in N+1]", () => {
    const blockN = 100;
    const blockN1 = 101;
    const subFrames = [
      { subFrame: 28, hmac: computeSubFrameHmac(secret, eventId, blockN, 28) },
      { subFrame: 29, hmac: computeSubFrameHmac(secret, eventId, blockN, 29) },
      { subFrame: 0, hmac: computeSubFrameHmac(secret, eventId, blockN1, 0) },
    ];
    // timeBlock = N+1 (last captured frame's block). The function tries
    // timeBlock and timeBlock-1 for each frame.
    const result = verifySubFrameLiveness(subFrames, secret, eventId, blockN1);
    expect(result.ok).toBe(true);
  });

  it("accepts a boundary-straddling scan: [29 in N] + [0,1 in N+1]", () => {
    const blockN = 100;
    const blockN1 = 101;
    const subFrames = [
      { subFrame: 29, hmac: computeSubFrameHmac(secret, eventId, blockN, 29) },
      { subFrame: 0, hmac: computeSubFrameHmac(secret, eventId, blockN1, 0) },
      { subFrame: 1, hmac: computeSubFrameHmac(secret, eventId, blockN1, 1) },
    ];
    const result = verifySubFrameLiveness(subFrames, secret, eventId, blockN1);
    expect(result.ok).toBe(true);
  });

  it("accepts 4-frame boundary straddle: [28,29 in N] + [0,1 in N+1]", () => {
    const blockN = 200;
    const blockN1 = 201;
    const subFrames = [
      { subFrame: 28, hmac: computeSubFrameHmac(secret, eventId, blockN, 28) },
      { subFrame: 29, hmac: computeSubFrameHmac(secret, eventId, blockN, 29) },
      { subFrame: 0, hmac: computeSubFrameHmac(secret, eventId, blockN1, 0) },
      { subFrame: 1, hmac: computeSubFrameHmac(secret, eventId, blockN1, 1) },
    ];
    const result = verifySubFrameLiveness(subFrames, secret, eventId, blockN1);
    expect(result.ok).toBe(true);
  });

  it("accepts unsorted boundary-straddling frames (sorts by block then subFrame)", () => {
    const blockN = 100;
    const blockN1 = 101;
    // Deliberately unsorted: frame 0 of N+1 first, then 29 of N, then 28 of N.
    const subFrames = [
      { subFrame: 0, hmac: computeSubFrameHmac(secret, eventId, blockN1, 0) },
      { subFrame: 29, hmac: computeSubFrameHmac(secret, eventId, blockN, 29) },
      { subFrame: 28, hmac: computeSubFrameHmac(secret, eventId, blockN, 28) },
    ];
    const result = verifySubFrameLiveness(subFrames, secret, eventId, blockN1);
    expect(result.ok).toBe(true);
  });

  it("rejects a 2-block gap (frames in N and N+2, no N+1)", () => {
    const blockN = 100;
    const blockN2 = 102;
    // Frames 29 of N and 0 of N+2 — there's a full block gap (N+1 missing).
    // timeBlock=N+2; function tries N+2 and N+1. Frame 29 of N matches neither.
    const subFrames = [
      { subFrame: 0, hmac: computeSubFrameHmac(secret, eventId, blockN2, 0) },
      { subFrame: 1, hmac: computeSubFrameHmac(secret, eventId, blockN2, 1) },
      { subFrame: 29, hmac: computeSubFrameHmac(secret, eventId, blockN, 29) },
    ];
    const result = verifySubFrameLiveness(subFrames, secret, eventId, blockN2);
    expect(result.ok).toBe(false);
  });

  it("rejects a boundary straddle where prev frame is mid-block (not at the end)", () => {
    const blockN = 100;
    const blockN1 = 101;
    // Frame 15 of N then frame 0 of N+1 — the prev frame isn't at the end
    // of its block, so this isn't a valid boundary straddle.
    const subFrames = [
      { subFrame: 15, hmac: computeSubFrameHmac(secret, eventId, blockN, 15) },
      { subFrame: 16, hmac: computeSubFrameHmac(secret, eventId, blockN, 16) },
      { subFrame: 0, hmac: computeSubFrameHmac(secret, eventId, blockN1, 0) },
    ];
    const result = verifySubFrameLiveness(subFrames, secret, eventId, blockN1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_subframe");
    }
  });

  it("rejects duplicate frames (same block + subFrame twice)", () => {
    const subFrames = [
      { subFrame: 5, hmac: computeSubFrameHmac(secret, eventId, timeBlock, 5) },
      { subFrame: 5, hmac: computeSubFrameHmac(secret, eventId, timeBlock, 5) },
      { subFrame: 6, hmac: computeSubFrameHmac(secret, eventId, timeBlock, 6) },
    ];
    const result = verifySubFrameLiveness(subFrames, secret, eventId, timeBlock);
    expect(result.ok).toBe(false);
  });

  // ---- Boundary asymmetry fix (unified temporal index) ----
  // The old code allowed (28 in N -> 1 in N+1) as an adjacent-block pair
  // (prev>=28, curr<=1), a 3-frame gap (1500ms), while rejecting same-block
  // diff=3 (also 1500ms). The unified temporal index treats both identically.
  // Test case: [28 in N, 1 in N+1, 2 in N+1] — the 28->1 pair is a 3-frame gap.
  it("rejects boundary straddle (28 in N -> 1 in N+1): 3-frame gap", () => {
    const blockN = 100;
    const blockN1 = 101;
    const subFrames = [
      { subFrame: 28, hmac: computeSubFrameHmac(secret, eventId, blockN, 28) },
      { subFrame: 1, hmac: computeSubFrameHmac(secret, eventId, blockN1, 1) },
      { subFrame: 2, hmac: computeSubFrameHmac(secret, eventId, blockN1, 2) },
    ];
    const result = verifySubFrameLiveness(subFrames, secret, eventId, blockN1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_subframe");
    }
  });

  it("rejects same-block diff=3 (consistency with boundary case)", () => {
    const subFrames = [0, 3, 5].map((sf) => ({
      subFrame: sf,
      hmac: computeSubFrameHmac(secret, eventId, timeBlock, sf),
    }));
    const result = verifySubFrameLiveness(subFrames, secret, eventId, timeBlock);
    expect(result.ok).toBe(false);
  });
});
