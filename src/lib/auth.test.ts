import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  generateRefreshToken,
  hashToken,
  verifyToken,
  signAccessToken,
  verifyAccessToken,
  ACCESS_COOKIE,
  REFRESH_COOKIE,
} from "./auth";

// ====================================================================
// Unit tests for the auth helpers.
// These verify the password hashing (used by register/login), the
// refresh-token generation/verification (used by session rotation),
// and the access-token signing/verification (used by every authed API).
// ====================================================================

describe("hashPassword / verifyPassword", () => {
  it("hashes a password and verifies it correctly", async () => {
    const password = "MyStrongPass1";
    const hash = await hashPassword(password);
    expect(hash).not.toBe(password);
    expect(hash.length).toBeGreaterThan(20);
    const valid = await verifyPassword(password, hash);
    expect(valid).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("CorrectPass1");
    const valid = await verifyPassword("WrongPass1", hash);
    expect(valid).toBe(false);
  });

  it("produces DIFFERENT hashes for the same password (salt)", async () => {
    // bcrypt includes a random salt, so two hashes of the same password
    // should differ. This is critical for security — if they were
    // identical, an attacker with DB access could spot duplicate
    // passwords instantly.
    const h1 = await hashPassword("SamePass1");
    const h2 = await hashPassword("SamePass1");
    expect(h1).not.toBe(h2);
    // But both should verify against the original password.
    expect(await verifyPassword("SamePass1", h1)).toBe(true);
    expect(await verifyPassword("SamePass1", h2)).toBe(true);
  });
});

describe("generateRefreshToken", () => {
  it("produces a non-empty string", () => {
    const token = generateRefreshToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(20);
  });

  it("produces UNIQUE tokens on each call", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateRefreshToken());
    }
    expect(tokens.size).toBe(100);
  });
});

describe("hashToken / verifyToken (refresh token rotation)", () => {
  it("hashes a refresh token and verifies it", () => {
    const token = generateRefreshToken();
    const hash = hashToken(token);
    expect(hash).not.toBe(token);
    expect(verifyToken(token, hash)).toBe(true);
  });

  it("rejects a wrong token against a hash", () => {
    const token = generateRefreshToken();
    const hash = hashToken(token);
    expect(verifyToken("wrong-token", hash)).toBe(false);
  });

  it("produces DETERMINISTIC hashes for the same token (HMAC-SHA256, no salt)", () => {
    // v8: hashToken now uses HMAC-SHA256 (deterministic) instead of bcrypt
    // (random salt). This is intentional — it allows O(1) lookup via a
    // unique index on tokenHash. The pepper (REFRESH_SECRET) means even
    // if the DB leaks, tokens can't be brute-forced without the secret.
    const token = generateRefreshToken();
    const h1 = hashToken(token);
    const h2 = hashToken(token);
    expect(h1).toBe(h2); // deterministic
    expect(verifyToken(token, h1)).toBe(true);
    expect(verifyToken(token, h2)).toBe(true);
  });
});

describe("signAccessToken / verifyAccessToken", () => {
  it("signs and verifies a valid access token", async () => {
    const payload = {
      sub: "account-123",
      role: "USER" as const,
      status: "ACTIVE" as const,
      type: "access" as const,
    };
    const token = await signAccessToken(payload);
    expect(typeof token).toBe("string");
    const decoded = await verifyAccessToken(token);
    expect(decoded).not.toBeNull();
    if (decoded) {
      expect(decoded.sub).toBe("account-123");
      expect(decoded.role).toBe("USER");
      expect(decoded.status).toBe("ACTIVE");
      expect(decoded.type).toBe("access");
    }
  });

  it("rejects a tampered token", async () => {
    const token = await signAccessToken({
      sub: "account-123",
      role: "USER",
      status: "ACTIVE",
      type: "access",
    });
    // Tamper with the token by flipping the last character.
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    const decoded = await verifyAccessToken(tampered);
    expect(decoded).toBeNull();
  });

  it("rejects a garbage token", async () => {
    const decoded = await verifyAccessToken("not-a-valid-token");
    expect(decoded).toBeNull();
  });

  it("encodes the role and status (used by RBAC)", async () => {
    // The access token carries the role/status so middleware and API
    // routes can check permissions without a DB lookup on every request.
    for (const role of ["ADMIN", "ORGANIZER", "USER"] as const) {
      for (const status of ["ACTIVE", "SUSPENDED", "PENDING_VERIFICATION"] as const) {
        const token = await signAccessToken({
          sub: `acct-${role}`,
          role,
          status,
          type: "access",
        });
        const decoded = await verifyAccessToken(token);
        expect(decoded?.role).toBe(role);
        expect(decoded?.status).toBe(status);
      }
    }
  });
});

describe("cookie names", () => {
  it("exports stable cookie name constants", () => {
    expect(ACCESS_COOKIE).toBe("ng_access");
    expect(REFRESH_COOKIE).toBe("ng_refresh");
    expect(ACCESS_COOKIE).not.toBe(REFRESH_COOKIE);
  });
});

// ====================================================================
// Activation flow verification
// ====================================================================
describe("Account activation flow (no OTP)", () => {
  // These tests document and enforce the intended activation flow:
  //   1. Register → account created as PENDING_VERIFICATION
  //   2. Login with correct credentials → status flipped to ACTIVE
  //
  // The actual DB writes happen in the route handlers, but we verify
  // here that the access-token signing accepts a PENDING_VERIFICATION
  // status (so the login route CAN issue a session for a newly-activated
  // account).

  it("can sign an access token with PENDING_VERIFICATION status", async () => {
    // Before activation, the login route signs a token with the
    // PENDING_VERIFICATION status, then flips it to ACTIVE in the DB.
    const token = await signAccessToken({
      sub: "pending-acct",
      role: "USER",
      status: "PENDING_VERIFICATION",
      type: "access",
    });
    const decoded = await verifyAccessToken(token);
    expect(decoded?.status).toBe("PENDING_VERIFICATION");
  });

  it("can sign an access token with ACTIVE status (post-activation)", async () => {
    // After the login route flips the status, it signs a new token with
    // the ACTIVE status.
    const token = await signAccessToken({
      sub: "activated-acct",
      role: "USER",
      status: "ACTIVE",
      type: "access",
    });
    const decoded = await verifyAccessToken(token);
    expect(decoded?.status).toBe("ACTIVE");
  });
});
