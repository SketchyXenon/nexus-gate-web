// ====================================================================
// Nexus Gate — Authentication Core
// JWT access tokens (short-lived) + refresh tokens (rotating).
// Account verification via OTP. Hardware-fingerprint bonding.
// ====================================================================

import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { createHmac, createHash, randomBytes, timingSafeEqual } from "crypto";

// ---- JWT secrets ----
// In production, these MUST be set via env vars. If they're missing,
// the app throws on startup (fail-closed). In development, we allow
// a fallback for convenience.
//
// IMPORTANT: The production check only runs on the SERVER (Node.js runtime),
// NOT in the browser. Environment variables are not available in the browser,
// so the check would always fail client-side. We guard with typeof window
// to skip the check during client-side evaluation.
const ACCESS_SECRET_RAW = process.env.AUTH_SECRET;
const REFRESH_SECRET_RAW = process.env.REFRESH_SECRET;

if (
  process.env.NODE_ENV === "production" &&
  typeof window === "undefined" // Server-only check
) {
  if (!ACCESS_SECRET_RAW || ACCESS_SECRET_RAW.length < 32) {
    throw new Error("FATAL: AUTH_SECRET env var must be set to a random string of at least 32 characters in production.");
  }
  if (!REFRESH_SECRET_RAW || REFRESH_SECRET_RAW.length < 32) {
    throw new Error("FATAL: REFRESH_SECRET env var must be set to a random string of at least 32 characters in production.");
  }
}

const ACCESS_SECRET = new TextEncoder().encode(
  ACCESS_SECRET_RAW || "dev-only-access-secret-not-for-production-32b!"
);
const REFRESH_SECRET = new TextEncoder().encode(
  REFRESH_SECRET_RAW || "dev-only-refresh-secret-not-for-prod-32b!"
);
// String version for use with Node's createHmac (which expects string keys)
const REFRESH_SECRET_STR = REFRESH_SECRET_RAW || "dev-only-refresh-secret-not-for-prod-32b!";

const ACCESS_TOKEN_TTL = "15m"; // 15 minutes
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_OTP_ATTEMPTS = 5;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

export const ACCESS_COOKIE = "ng_access";
export const REFRESH_COOKIE = "ng_refresh";
export const ACCESS_TTL_SECONDS = 15 * 60;

export interface AccessTokenPayload {
  sub: string; // account.id
  role: string; // ADMIN | ORGANIZER | USER
  status: string; // ACTIVE | ...
  // Token type to prevent confusion attacks
  type: "access";
}

// ---- Password hashing ----
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ---- Access token (JWT) ----
export async function signAccessToken(
  payload: Omit<AccessTokenPayload, "type">
): Promise<string> {
  return new SignJWT({ ...payload, type: "access" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .setIssuer("nexus-gate")
    .setAudience("nexus-gate-client")
    .sign(ACCESS_SECRET);
}

export async function verifyAccessToken(
  token: string
): Promise<AccessTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, ACCESS_SECRET, {
      issuer: "nexus-gate",
      audience: "nexus-gate-client",
    });
    if (payload.type !== "access") return null;
    return {
      sub: payload.sub as string,
      role: payload.role as string,
      status: payload.status as string,
      type: "access",
    };
  } catch {
    return null;
  }
}

// ---- Refresh token (opaque, HMAC-SHA256 hashed in DB for O(1) lookup) ----
// SECURITY + SCALABILITY (v8): Previously used bcrypt which is O(n) for
// lookup (must scan all tokens and bcrypt.compare each). Now uses
// HMAC-SHA256 with a pepper (REFRESH_SECRET) so the hash is deterministic
// and can be looked up via a unique index in O(1). The pepper means even
// if the DB leaks, tokens can't be brute-forced without the secret.
export function generateRefreshToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return hmacSha256(REFRESH_SECRET_STR, token);
}

export function verifyToken(token: string, hash: string): boolean {
  const expected = hashToken(token);
  return safeEqual(expected, hash);
}

// ---- Constant-time string comparison (prevents timing attacks) ----
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  return timingSafeEqual(aBuf, bBuf);
}

export const REFRESH_TTL_MS = REFRESH_TOKEN_TTL_MS;

// ---- OTP (verification code) ----
export function generateOtp(): string {
  // Cryptographically random 6-digit code
  const bytes = randomBytes(4);
  const num = bytes.readUInt32BE(0) % 1000000;
  return num.toString().padStart(6, "0");
}

export async function hashOtp(code: string): Promise<string> {
  return bcrypt.hash(code, 10);
}

export async function verifyOtp(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(code, hash);
}

export const OTP_CONFIG = {
  ttlMs: OTP_TTL_MS,
  maxAttempts: MAX_OTP_ATTEMPTS,
};

// ---- Password reset token ----
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function generateResetToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const LOGIN_SECURITY = {
  maxAttempts: MAX_LOGIN_ATTEMPTS,
  lockoutMs: LOGIN_LOCKOUT_MS,
};

// ---- HMAC (for QR tokens, shared with qr-token.ts) ----
export function hmacSha256(key: string, message: string): string {
  return createHmac("sha256", key).update(message).digest("hex");
}
