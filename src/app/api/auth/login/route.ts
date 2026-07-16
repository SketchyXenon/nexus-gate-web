// Allow up to 15s for Supabase Auth round-trips (Hobby default is 10s).
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { loginSchema } from "@/lib/validation";
import {
  badRequest,
  checkRateLimitByEmail,
  checkRateLimitByKey,
  parseBody,
  unauthorized,
  dbUnavailable,
  isDbUnavailableError,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";
import { verifyPassword } from "@/lib/auth";
import { invalidateAccountCache } from "@/lib/supabase-session";

// Brute-force protection constants.
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// POST /api/auth/login
// Signs in via Supabase Auth (prod) or bcrypt verify (dev), then activates
// PENDING_VERIFICATION accounts. Rejects deactivated (soft-deleted) accounts.
export async function POST(req: NextRequest) {
  try {
    if (!isSupabaseConfigured() && !isDevAuthMode()) {
      return NextResponse.json(
        {
          error:
            "Authentication is not configured. Contact your administrator.",
          code: "AUTH_NOT_CONFIGURED",
        },
        { status: 503 },
      );
    }

    const body = await parseBody(req);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const { email, password } = parsed.data;

    // Per-email rate limit (5/min).
    const rl = await checkRateLimitByEmail(email, "login");
    if (rl) return rl;

    // ---- Pre-auth lockout + deactivation check ----
    const preCheck = await db.account.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        supabaseAuthUid: true,
        status: true,
        passwordHash: true,
        isDeactivated: true,
        failedLoginAttempts: true,
        lockedUntil: true,
      },
    });

    // Reject deactivated accounts immediately (soft-deleted).
    if (preCheck?.isDeactivated) {
      return NextResponse.json(
        {
          error:
            "This account has been deactivated. Please contact an administrator if you wish to restore it.",
          code: "ACCOUNT_DEACTIVATED",
        },
        { status: 403 },
      );
    }

    if (preCheck?.lockedUntil && preCheck.lockedUntil > new Date()) {
      const retryMs = preCheck.lockedUntil.getTime() - Date.now();
      return NextResponse.json(
        {
          error: `Too many failed attempts. Please try again in ${Math.ceil(retryMs / 1000)} seconds.`,
          code: "LOCKED",
          retryAfterMs: retryMs,
        },
        { status: 423 },
      );
    }

    // Per-account checkpoint.
    if (preCheck) {
      const acctRl = await checkRateLimitByKey(preCheck.id, "loginAccount");
      if (acctRl) return acctRl;
    }

    // ---- Authenticate ----
    let authUid: string | null = null;

    if (isDevAuthMode()) {
      // Dev mode: verify bcrypt password hash directly.
      if (!preCheck || !preCheck.passwordHash) {
        return unauthorized(
          "Incorrect email or password. Check your details and try again.",
        );
      }
      const valid = await verifyPassword(password, preCheck.passwordHash);
      if (!valid) {
        await incrementFailedAttempts(preCheck.id);
        return unauthorized(
          "Incorrect email or password. Check your details and try again.",
        );
      }
      authUid = preCheck.id; // dev sessions use the account ID.
    } else {
      // Production: sign in via Supabase Auth.
      const supabase = await createSupabaseServerClient();
      const { data: authData, error: authError } =
        await supabase.auth.signInWithPassword({ email, password });

      if (authError || !authData.user) {
        if (preCheck) {
          await incrementFailedAttempts(preCheck.id);
        }
        const errMsg = authError?.message ?? "";
        if (
          errMsg.toLowerCase().includes("not confirmed") ||
          errMsg.toLowerCase().includes("email not confirmed")
        ) {
          return NextResponse.json(
            {
              error:
                "Please confirm your email first. Check your inbox for the verification link we sent when you registered.",
              code: "EMAIL_NOT_CONFIRMED",
            },
            { status: 403 },
          );
        }
        // Orphan reconciliation (production only).
        if (preCheck?.supabaseAuthUid && isSupabaseConfigured()) {
          try {
            const admin = createSupabaseAdminClient();
            const { data: userData } = await admin.auth.admin.getUserById(
              preCheck.supabaseAuthUid,
            );
            if (!userData?.user) {
              console.log(
                `[login] cleaning orphaned accounts row for ${email} (auth user deleted)`,
              );
              await db.account.delete({ where: { id: preCheck.id } });
            }
          } catch {
            // Can't verify - fall through to the generic error.
          }
        }
        return unauthorized(
          "Incorrect email or password. Check your details and try again.",
        );
      }
      authUid = authData.user.id;
    }

    // Load the linked accounts row.
    const account = await db.account.findFirst({
      where: isDevAuthMode() ? { id: authUid! } : { supabaseAuthUid: authUid! },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        status: true,
        studentId: true,
        program: true,
        section: true,
        isDeactivated: true,
      },
    });
    if (!account) {
      if (!isDevAuthMode()) {
        const supabase = await createSupabaseServerClient();
        await supabase.auth.signOut();
      }
      return unauthorized("Account not found. Contact your administrator.");
    }

    // Reject deactivated accounts (defense-in-depth).
    if (account.isDeactivated) {
      if (!isDevAuthMode()) {
        const supabase = await createSupabaseServerClient();
        await supabase.auth.signOut();
      }
      return NextResponse.json(
        {
          error:
            "This account has been deactivated. Please contact an administrator if you wish to restore it.",
          code: "ACCOUNT_DEACTIVATED",
        },
        { status: 403 },
      );
    }

    // Activate PENDING_VERIFICATION accounts on first successful login.
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
      (account as { status: string }).status = "ACTIVE";
      invalidateAccountCache(authUid!);
      await audit({
        actorId: account.id,
        action: "auth.account_activated",
        targetType: "Account",
        targetId: account.id,
        req,
      });
    }

    if (account.status === "SUSPENDED") {
      if (!isDevAuthMode()) {
        const supabase = await createSupabaseServerClient();
        await supabase.auth.signOut();
      }
      return NextResponse.json(
        {
          error:
            "Your account has been suspended. Please contact an administrator.",
          code: "SUSPENDED",
        },
        { status: 403 },
      );
    }

    // Revoke previous refresh tokens (legacy field, defense-in-depth).
    await db.refreshToken
      .updateMany({
        where: { accountId: account.id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      .catch(() => {});

    await db.account.update({
      where: { id: account.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });

    await audit({
      actorId: account.id,
      action: "auth.login",
      targetType: "Account",
      targetId: account.id,
      req,
    });

    const res = NextResponse.json(
      {
        id: account.id,
        email: account.email,
        fullName: account.fullName,
        role: account.role,
        status: account.status,
        studentId: account.studentId,
        program: account.program,
        section: account.section,
      },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } },
    );

    // In dev mode, set the signed session cookie.
    if (isDevAuthMode()) {
      setDevSessionCookie(res, account.id);
    }

    return res;
  } catch (e) {
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    throw e;
  }
}

// Helper: increment failed login attempts and lock if threshold reached.
async function incrementFailedAttempts(accountId: string): Promise<void> {
  const updated = await db.account
    .update({
      where: { id: accountId },
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    })
    .catch(() => null);
  if (updated && updated.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
    await db.account
      .update({
        where: { id: accountId },
        data: { lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) },
      })
      .catch(() => {});
  }
}
