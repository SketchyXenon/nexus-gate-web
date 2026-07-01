import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword, LOGIN_SECURITY } from "@/lib/auth";
import { setSessionCookies } from "@/lib/session";
import { loginSchema } from "@/lib/validation";
import {
  badRequest,
  checkRateLimit,
  parseBody,
  unauthorized,
  dbUnavailable,
  isDbUnavailableError,
} from "@/lib/api";
import { audit } from "@/lib/audit";

// POST /api/auth/login
// Wrapped in a top-level try/catch so that DB infrastructure errors
// (pooler conflicts, connection drops) return a clear 503 instead of
// an opaque 500. App-level errors (bad credentials, locked account)
// still return their normal status codes via early returns.
export async function POST(req: NextRequest) {
  try {
    const rl = await checkRateLimit(req, "login");
    if (rl) return rl;

    const body = await parseBody(req);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const { email, password } = parsed.data;

    const account = await db.account.findUnique({ where: { email } });
    if (!account) {
      // ---- Fake hash: run a bcrypt compare to equalize timing ----
      // Without this, non-existent emails respond faster than existing ones
      // (no bcrypt work), enabling timing-based user enumeration.
      await verifyPassword(
        password,
        "$2a$12$wQ8N9rF7pV3sH2kL5jY1beZMxG4tC8oN0vD6fB1eA3yI9mK7pL2qC",
      );
      return unauthorized(
        "Incorrect email or password. Check your details and try again.",
      );
    }

    if (account.lockedUntil && account.lockedUntil > new Date()) {
      const retryMs = account.lockedUntil.getTime() - Date.now();
      return NextResponse.json(
        {
          error: `Too many failed attempts. Please try again in ${Math.ceil(retryMs / 1000)} seconds.`,
          code: "LOCKED",
          retryAfterMs: retryMs,
        },
        { status: 423 },
      );
    }

    const valid = await verifyPassword(password, account.passwordHash);
    if (!valid) {
      const attempts = account.failedLoginAttempts + 1;
      const shouldLock = attempts >= LOGIN_SECURITY.maxAttempts;
      await db.account.update({
        where: { id: account.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil: shouldLock
            ? new Date(Date.now() + LOGIN_SECURITY.lockoutMs)
            : null,
        },
      });
      await audit({
        actorId: account.id,
        action: "auth.login_failed",
        targetType: "Account",
        targetId: account.id,
        metadata: { attempts },
        req,
      });
      // If we just locked the account, return 423 LOCKED immediately
      // (instead of 401). This tells the client the account is temporarily
      // locked and they should wait. Without this, the 5th failure returns
      // 401 and the client doesn't know about the lock until the next attempt.
      if (shouldLock) {
        const retryMs = LOGIN_SECURITY.lockoutMs;
        return NextResponse.json(
          {
            error: `Too many failed attempts. Please try again in ${Math.ceil(retryMs / 1000)} seconds.`,
            code: "LOCKED",
            retryAfterMs: retryMs,
          },
          { status: 423 },
        );
      }
      return unauthorized(
        "Incorrect email or password. Check your details and try again.",
      );
    }

    // ---- Activate PENDING_VERIFICATION accounts on successful login ----
    // After registration, the account is PENDING_VERIFICATION.
    // The user must log in again (proving they saved their credentials)
    // to activate the account. This is the "re-login to verify" flow.
    if (account.status === "PENDING_VERIFICATION") {
      await db.account.update({
        where: { id: account.id },
        data: {
          status: "ACTIVE",
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
        },
      });
      // Update the account object for the rest of the function
      (account as { status: string }).status = "ACTIVE";

      await audit({
        actorId: account.id,
        action: "auth.account_activated",
        targetType: "Account",
        targetId: account.id,
        req,
      });
    }

    if (account.status === "SUSPENDED") {
      return NextResponse.json(
        {
          error:
            "Your account has been suspended. Please contact an administrator.",
          code: "SUSPENDED",
        },
        { status: 403 },
      );
    }

    // ---- Anti-account-sharing: revoke ALL previous sessions ----
    // When a student logs in, we invalidate ALL their previous refresh tokens.
    // This means if someone else logs in with the same account, the original
    // user's session is killed. They'll be signed out and can see that
    // someone else accessed their account.
    //
    // This prevents account sharing because:
    //   1. Student A logs in on their phone
    //   2. Student B logs in with the same credentials on their phone
    //   3. Student A's session is immediately invalidated
    //   4. Student A notices they're signed out → reports the issue
    await db.refreshToken.updateMany({
      where: { accountId: account.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await db.account.update({
      where: { id: account.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });

    await setSessionCookies({
      accountId: account.id,
      role: account.role,
      status: account.status,
    });

    await audit({
      actorId: account.id,
      action: "auth.login",
      targetType: "Account",
      targetId: account.id,
      req,
    });

    return NextResponse.json({
      id: account.id,
      email: account.email,
      fullName: account.fullName,
      role: account.role,
      status: account.status,
      studentId: account.studentId,
      program: account.program,
      section: account.section,
    });
  } catch (e) {
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    throw e;
  }
}
