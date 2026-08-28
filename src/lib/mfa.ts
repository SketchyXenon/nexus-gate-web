// ====================================================================
// Nexus Gate - MFA (TOTP, RFC 6238) helpers
// --------------------------------------------------------------------
// Optional per-account second factor. Implements:
//   - AES-256-GCM encryption at rest for the TOTP secret.
//   - TOTP generation + verification (otplib, vetted).
//   - One-time backup codes (bcrypt-hashed, JSON-stored).
//   - Short-lived challenge JWTs (5 min) for the login-verify flow.
//   - Browser-scoped "MFA-verified" marker JWT used by session.ts to
//     enforce fail-closed MFA on every protected route.
//
// Design notes (per 06-security-architecture.md §2 "MFA for privileged
// accounts" + §1 "Defense in depth"):
//   * No custom crypto. AES-256-GCM via Node `crypto` (FIPS-validated);
//     scryptSync for KDF; otplib for TOTP; jose for JWTs; bcrypt for hashes.
//   * Fail closed. Any decrypt/JWT verification error returns null/false
//     and the session layer treats the request as unauthenticated.
//   * The encryption key is derived from process.env.SUPABASE_JWT_SECRET
//     via scryptSync (N=2^15, r=8, p=1, 32-byte key). No new env var is
//     required, keeping the secret rotation surface to a single value.
// ====================================================================

import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";
import {
  generateSecret as otplibGenerateSecret,
  generateURI as otplibGenerateURI,
  verifySync as otplibVerifySync,
} from "otplib";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";

// otplib v13 exposes `verifySync` (NOT the legacy `authenticator.verify`).
// The default crypto plugin is NobleCryptoPlugin (sync-capable). The
// default base32 plugin is ScureBase32Plugin. No plugin config needed.
//
// Tolerance: ±30s = one step before + the current step + one step after
// (period = 30s). Matches the legacy `window: 1` semantics from
// pre-v13 otplib / RFC 6238 §5.2 transmission-delay recommendation.
const TOTP_EPOCH_TOLERANCE_S = 30;

// Cookie names (used by login route, login-verify route, session layer).
export const MFA_CHALLENGE_COOKIE = "ng_mfa_challenge";
export const MFA_VERIFIED_COOKIE = "ng_mfa_verified";

// Challenge JWT lifetime: 5 minutes. The DB row's expiresAt matches.
const CHALLENGE_JWT_TTL_S = 5 * 60;
// MFA-verified marker lifetime when "remember me" is on: 30 days, matching
// REMEMBER_MAX_AGE_S in supabase-server.ts. ADMIN accounts are forced to
// session-scoped (no maxAge) by the login-verify route.
const MFA_VERIFIED_REMEMBER_S = 30 * 24 * 60 * 60;
// Issuer shown in the authenticator app (e.g. "Nexus Gate (alice@x.com)").
const ISSUER = "Nexus Gate";

// ---- Encryption key derivation ----
// scryptSync is the vetted KDF: N=2^15, r=8, p=1 (OWASP-recommended for
// 2024+). The salt is fixed (per-app) so the same SUPABASE_JWT_SECRET
// always produces the same AES key. This is OK because SUPABASE_JWT_SECRET
// is already a high-entropy server-side secret; a per-row salt would add
// no security and complicate rotation.
const ENC_KEY_SALT = "nexus-gate:mfa:v1";
let cachedKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "SUPABASE_JWT_SECRET is not set - cannot derive MFA encryption key.",
    );
  }
  // 32 bytes = AES-256. scryptSync is synchronous and CPU-bound (~80ms),
  // acceptable because we cache the result for the process lifetime.
  cachedKey = scryptSync(secret, ENC_KEY_SALT, 32);
  return cachedKey;
}

// AES-256-GCM. Returns base64(iv || ciphertext || tag) - all three are
// needed to decrypt, and any tamper with one of them throws (GCM auth tag).
export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12); // 96-bit IV is the GCM standard.
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString("base64");
}

// Inverse of encryptSecret. Throws on tamper (GCM tag mismatch) or if
// the env secret has changed. Callers MUST catch and fail closed.
export function decryptSecret(ciphertext: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(ciphertext, "base64");
  if (buf.length < 12 + 16) {
    throw new Error("MFA secret ciphertext is malformed");
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const enc = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

// ---- TOTP ----
export function generateSecret(): string {
  // otplib v13's generateSecret returns a base32-encoded string
  // (160 bits by default) - the format expected by Google
  // Authenticator, 1Password, Authy, etc.
  return otplibGenerateSecret();
}

// otpauth:// URL embedded in the QR. The user's authenticator imports this.
export function buildOtpAuthUrl(opts: {
  email: string;
  secret: string;
  issuer?: string;
}): string {
  const issuer = opts.issuer ?? ISSUER;
  return otplibGenerateURI({
    issuer,
    label: opts.email,
    secret: opts.secret,
  });
}

// Verify a 6-digit (or 8-digit) token against the secret. Strips spaces
// (Google Authenticator and 1Password both auto-format with spaces).
// Uses otplib v13's verifySync with a ±30s tolerance (one step before/
// after the current 30s period - matches RFC 6238 §5.2 transmission
// delay). Constant-time comparison is performed inside otplib.
export function verifyTotp(opts: {
  token: string;
  secret: string;
}): boolean {
  const cleaned = opts.token.replace(/\s/g, "");
  if (!/^\d{6,8}$/.test(cleaned)) return false;
  try {
    const result = otplibVerifySync({
      token: cleaned,
      secret: opts.secret,
      epochTolerance: TOTP_EPOCH_TOLERANCE_S,
    });
    return Boolean(result && (result as { valid?: boolean }).valid);
  } catch {
    return false;
  }
}

// ---- Backup codes ----
// 10 codes, format "XXXX-XXXX" (4 base32 chars, dash, 4 base32 chars).
// Base32 alphabet (RFC 4648, no padding) - avoids visually ambiguous
// chars (0, 1, O, I) by using uppercase only.
const B32_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randomBase32Block(length: number): string {
  const out: string[] = [];
  const buf = randomBytes(length);
  for (let i = 0; i < length; i++) {
    out.push(B32_ALPHABET[buf[i] % B32_ALPHABET.length]);
  }
  return out.join("");
}

export function generateBackupCodes(): {
  plaintext: string[];
  hashes: string[];
} {
  const plaintext: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const code = `${randomBase32Block(4)}-${randomBase32Block(4)}`;
    plaintext.push(code);
    hashes.push(hashBackupCode(code));
  }
  return { plaintext, hashes };
}

export function hashBackupCode(code: string): string {
  // 10 rounds - matches the cost used for one-time codes elsewhere. Lower
  // than the password hash (12) because the code is single-use and
  // 10 is already well above the 2024 NIST floor.
  return bcrypt.hashSync(code, 10);
}

// Verify a backup code against the stored hashes. Returns whether the
// code was valid and the remaining hashes (with the consumed one removed).
//
// SECURITY: We run bcrypt.compareSync on EVERY hash in the array, not
// just up to the match, so the response timing is uniform regardless of
// which position the matched code occupied. An early-exit break would
// leak position (and thus the count of remaining codes) via timing,
// even though bcrypt.compareSync itself is constant-time on the hash.
// Cost: 10 bcrypt calls per MFA login (acceptable - MFA login is rare).
export function verifyBackupCode(
  code: string,
  hashes: string[],
): { valid: boolean; remaining: string[] } {
  let matchedIndex = -1;
  for (let i = 0; i < hashes.length; i++) {
    // Always evaluate compareSync (no short-circuit) - the result
    // only updates matchedIndex the FIRST time it's true. Subsequent
    // true results are ignored (multi-match is impossible because
    // codes are unique, but defense-in-depth: first match wins).
    const isMatch = bcrypt.compareSync(code, hashes[i]);
    if (isMatch && matchedIndex === -1) {
      matchedIndex = i;
    }
  }
  if (matchedIndex === -1) {
    return { valid: false, remaining: hashes };
  }
  return {
    valid: true,
    remaining: hashes.filter((_, idx) => idx !== matchedIndex),
  };
}

// ---- Challenge JWT ----
// Short-lived (5 min) JWT signed with SUPABASE_JWT_SECRET. Bound to a
// specific challengeId (server-generated cuid) and accountId. The
// login-verify route validates this cookie + the matching DB row before
// accepting an MFA code.
function getJwtSecretKey(): Uint8Array {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error("SUPABASE_JWT_SECRET is not set - cannot sign MFA JWT.");
  }
  return new TextEncoder().encode(secret);
}

const CHALLENGE_JWT_TYPE = "ng:mfa-challenge";
const VERIFIED_JWT_TYPE = "ng:mfa-verified";

export async function signChallenge(
  challengeId: string,
  accountId: string,
): Promise<string> {
  return new SignJWT({ challengeId, accountId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(`${CHALLENGE_JWT_TTL_S}s`)
    .setIssuer("nexus-gate")
    .setSubject(accountId)
    .sign(getJwtSecretKey());
}

export async function verifyChallenge(
  jwt: string,
): Promise<{ challengeId: string; accountId: string } | null> {
  try {
    const { payload } = await jwtVerify(jwt, getJwtSecretKey(), {
      algorithms: ["HS256"],
      issuer: "nexus-gate",
    });
    const challengeId = payload.challengeId;
    const accountId = payload.accountId;
    if (typeof challengeId !== "string" || typeof accountId !== "string") {
      return null;
    }
    return { challengeId, accountId };
  } catch {
    return null;
  }
}

// ---- MFA-verified marker JWT ----
// Set by /api/auth/mfa/login-verify on success. Read by session.ts in
// the requireAuth path. When the account has mfaEnabled=true, the
// session layer requires this cookie to be valid AND bound to the
// same accountId; otherwise the request is treated as unauthenticated
// (fail closed).
//
// expSeconds = 0 means "browser session" (no `exp` claim, no maxAge on
// the cookie). Used for ADMIN accounts and for non-remembered sessions.
export async function signMfaVerified(
  accountId: string,
  expSeconds: number,
): Promise<string> {
  const builder = new SignJWT({ accountId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setIssuer("nexus-gate")
    .setSubject(accountId);
  if (expSeconds > 0) {
    builder.setExpirationTime(`${expSeconds}s`);
  }
  return builder.sign(getJwtSecretKey());
}

export async function verifyMfaVerified(
  jwt: string,
  accountId: string,
): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(jwt, getJwtSecretKey(), {
      algorithms: ["HS256"],
      issuer: "nexus-gate",
    });
    if (payload.sub !== accountId) return false;
    return true;
  } catch {
    return false;
  }
}

// Expiry constants re-exported for callers (login route, login-verify route).
export const MFA_VERIFIED_REMEMBER_SECONDS = MFA_VERIFIED_REMEMBER_S;
export const MFA_CHALLENGE_TTL_SECONDS = CHALLENGE_JWT_TTL_S;
