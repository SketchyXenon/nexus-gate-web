// ====================================================================
// Nexus Gate — Session Management
// Supports BOTH custom JWT cookies (email/password) AND NextAuth
// (Google OAuth) sessions. Checks NextAuth first, then custom cookies.
// ====================================================================

import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { db } from "@/lib/db";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_MS,
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashToken,
  verifyToken,
  type AccessTokenPayload,
} from "@/lib/auth";

const isProduction = process.env.NODE_ENV === "production";

const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: isProduction,
  path: "/",
};

// ---- Read current session (checks NextAuth first, then custom JWT) ----
export async function getSession(): Promise<AccessTokenPayload | null> {
  // 1. Check NextAuth (Google OAuth) session.
  try {
    const nextAuthSession = await getServerSession(authOptions);
    if (nextAuthSession?.user?.email) {
      return {
        sub: (nextAuthSession.user as { id: string }).id,
        role: (nextAuthSession.user as { role: string }).role,
        status: (nextAuthSession.user as { status: string }).status,
        type: "access",
      };
    }
  } catch {
    // NextAuth not configured or no session — fall through to custom.
  }

  // 2. Check custom JWT cookie (email/password).
  const cookieStore = await cookies();
  const token = cookieStore.get(ACCESS_COOKIE)?.value;
  if (!token) return null;
  return verifyAccessToken(token);
}

// ---- Get the full account record for the current session ----
// IMPORTANT: We always fetch from the database on every request to ensure
// the status is current. The JWT/NextAuth token's cached status is NOT
// trusted — an admin can suspend an account and it takes effect immediately.
export async function getCurrentAccount() {
  const session = await getSession();
  if (!session) return null;
  const account = await db.account.findUnique({
    where: { id: session.sub },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      status: true,
      studentId: true,
      program: true,
      section: true,
      organizationName: true,
      year: true,
    },
  });
  // Check the DATABASE status, not the token's cached status.
  // This ensures suspended accounts are immediately blocked.
  if (!account || account.status !== "ACTIVE") return null;
  return account;
}

// ---- Set both access + refresh token cookies ----
export async function setSessionCookies(params: {
  accountId: string;
  role: string;
  status: string;
}): Promise<{ refreshToken: string }> {
  const access = await signAccessToken({
    sub: params.accountId,
    role: params.role,
    status: params.status,
  });
  const refreshToken = generateRefreshToken();
  const refreshHash = await hashToken(refreshToken);

  await db.refreshToken.create({
    data: {
      accountId: params.accountId,
      tokenHash: refreshHash,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(ACCESS_COOKIE, access, {
    ...cookieOptions,
    maxAge: ACCESS_TTL_SECONDS,
  });
  cookieStore.set(REFRESH_COOKIE, refreshToken, {
    ...cookieOptions,
    maxAge: REFRESH_TTL_MS / 1000,
  });

  return { refreshToken };
}

// ---- Clear session cookies + revoke refresh token ----
// v8: O(1) lookup via HMAC-SHA256 hash (deterministic, indexed).
export async function clearSessionCookies() {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(REFRESH_COOKIE)?.value;
  if (refreshToken) {
    // Compute the hash and look up the token directly (O(1) via unique index)
    const tokenHash = hashToken(refreshToken);
    await db.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  cookieStore.delete(ACCESS_COOKIE);
  cookieStore.delete(REFRESH_COOKIE);
}

// ---- Refresh token rotation: verify old, issue new, revoke old ----
// Reuse detection: if a revoked token is presented, revoke ALL tokens
// for that account (potential session hijacking).
//
// v8: O(1) lookup via HMAC-SHA256 hash. Previously was O(n) with bcrypt
// (scanned up to 500 tokens, ~50ms each = 25s worst case). Now uses a
// direct findUnique on the tokenHash unique index.
export async function rotateRefreshToken(
  presentedToken: string
): Promise<{ ok: boolean; accountId?: string; role?: string; status?: string }> {
  const tokenHash = hashToken(presentedToken);

  // O(1) lookup for an active (non-revoked, non-expired) token
  const active = await db.refreshToken.findFirst({
    where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
  });

  if (active) {
    // Atomic conditional revoke — defeats the race (only one request wins)
    const revoked = await db.refreshToken.updateMany({
      where: { id: active.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) {
      // Lost the race — another request already revoked it
      return { ok: false };
    }

    const account = await db.account.findUnique({
      where: { id: active.accountId },
      select: { id: true, role: true, status: true },
    });
    if (!account || account.status !== "ACTIVE") {
      return { ok: false };
    }

    // Issue a fresh pair.
    await setSessionCookies({
      accountId: account.id,
      role: account.role,
      status: account.status,
    });

    return {
      ok: true,
      accountId: account.id,
      role: account.role,
      status: account.status,
    };
  }

  // Check if it matches a REVOKED token → reuse attack → nuke all.
  // O(1) lookup via the hash index.
  const revokedToken = await db.refreshToken.findFirst({
    where: { tokenHash, revokedAt: { not: null } },
  });
  if (revokedToken) {
    // REUSE DETECTED: revoke all tokens for this account.
    await db.refreshToken.updateMany({
      where: { accountId: revokedToken.accountId },
      data: { revokedAt: new Date() },
    });
  }
  return { ok: false };
}
