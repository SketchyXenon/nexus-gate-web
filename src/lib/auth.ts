// ====================================================================
// Nexus Gate — Authentication Core
// JWT access tokens (short-lived) + refresh tokens (rotating).
// Account verification via OTP. Hardware-fingerprint bonding.
// ====================================================================

import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { createHmac, createHash, randomBytes, timingSafeEqual } from "crypto";

// ---- JWT secrets ----
// In production, these MUST be set via env vars. Validation is LAZY —
// it runs the first time a token is signed/verified (at request time),
// NOT at module load. This is critical because `next build` imports
// every route module to collect page data, and that import must not
// throw even if the secrets aren't set in the build environment. The
// real fail-closed check happens on the first runtime crypto operation.
//
// IMPORTANT: The production check only runs on the SERVER (Node.js runtime),
// NOT in the browser. We guard with typeof window to skip client-side.
const ACCESS_SECRET_RAW = process.env.AUTH_SECRET;
const REFRESH_SECRET_RAW = process.env.REFRESH_SECRET;

const DEV_ACCESS_FALLBACK = "dev-only-access-secret-not-for-production-32b!";
const DEV_REFRESH_FALLBACK = "dev-only-refresh-secret-not-for-prod-32b!";

function ensureSecret(name: string, value: string | undefined): string {
  if (
    process.env.NODE_ENV === "production" &&
    typeof window === "undefined" // Server-only
  ) {
    if (!value || value.length < 32) {
      throw new Error(
        `FATAL: ${name} env var must be set to a random string of at least 32 characters in production.`,
      );
    }
  }
  return (
    value ||
    (name === "AUTH_SECRET" ? DEV_ACCESS_FALLBACK : DEV_REFRESH_FALLBACK)
  );
}

// Lazy-initialized secret bytes — only validated/encoded when first used.
let _accessSecret: Uint8Array | null = null;
function getAccessSecret(): Uint8Array {
  if (!_accessSecret) {
    _accessSecret = new TextEncoder().encode(
      ensureSecret("AUTH_SECRET", ACCESS_SECRET_RAW),
    );
  }
  return _accessSecret;
}

let _refreshSecretStr: string | null = null;
function getRefreshSecretStr(): string {
  if (_refreshSecretStr === null) {
    _refreshSecretStr = ensureSecret("REFRESH_SECRET", REFRESH_SECRET_RAW);
  }
  return _refreshSecretStr;
}

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
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ---- Access token (JWT) ----
export async function signAccessToken(
  payload: Omit<AccessTokenPayload, "type">,
): Promise<string> {
  return new SignJWT({ ...payload, type: "access" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .setIssuer("nexus-gate")
    .setAudience("nexus-gate-client")
    .sign(getAccessSecret());
}

export async function verifyAccessToken(
  token: string,
): Promise<AccessTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getAccessSecret(), {
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
  return hmacSha256(getRefreshSecretStr(), token);
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
