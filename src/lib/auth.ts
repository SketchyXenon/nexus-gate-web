// Nexus Gate - Auth helpers (bcrypt + HMAC).
// Supabase Auth handles sessions, passwords, and email flows now.
// This module keeps only the bcrypt password wrappers (used by tests)
// and the HMAC helper (used by QR token modules).

import bcrypt from "bcryptjs";
import { createHmac } from "crypto";

// Session payload shape (used by src/lib/session.ts to represent the
// resolved account from the Supabase session).
export interface AccessTokenPayload {
  sub: string;
  role: string;
  status: string;
  type: "access";
}

// Bcrypt password hashing (12 rounds).
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// HMAC-SHA256 (used by QR token modules for signing scan certificates).
export function hmacSha256(key: string, message: string): string {
  return createHmac("sha256", key).update(message).digest("hex");
}
