import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
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
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";

// Brute-force protection constants.
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// POST /api/auth/login
// Signs in via Supabase Auth, then activates PENDING_VERIFICATION accounts.
export async function POST(req: NextRequest) {
  try {
    if (!isSupabaseConfigured()) {
      return NextResponse.json(
        {
          error:
            "Authentication is not configured. Contact your administrator.",
          code: "AUTH_NOT_CONFIGURED",
        },
        { status: 503 },
      );
    }
    const rl = await checkRateLimit(req, "login");
    if (rl) return rl;

    const body = await parseBody(req);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const { email, password } = parsed.data;

    // ---- Pre-auth lockout check ----
    // Check if the account is locked BEFORE calling Supabase auth.
    // This prevents brute-force even if Supabase's own rate limit is bypassed.
    const preCheck = await db.account.findUnique({ where: { email } });
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

    // Sign in via Supabase Auth (sets the session cookie).
    const supabase = await createSupabaseServerClient();
    const { data: authData, error: authError } =
      await supabase.auth.signInWithPassword({
        email,
        password,
      });

    if (authError || !authData.user) {
      // ---- Increment failed login attempts ----
      if (preCheck) {
        const newAttempts = (preCheck.failedLoginAttempts ?? 0) + 1;
        const shouldLock = newAttempts >= MAX_FAILED_ATTEMPTS;
        await db.account
          .update({
            where: { id: preCheck.id },
            data: {
              failedLoginAttempts: newAttempts,
              ...(shouldLock
                ? { lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) }
                : {}),
            },
          })
          .catch(() => {});
        if (shouldLock) {
          return NextResponse.json(
            {
              error: `Too many failed attempts. Your account is locked for 15 minutes.`,
              code: "LOCKED",
              retryAfterMs: LOCK_DURATION_MS,
            },
            { status: 423 },
          );
        }
      }

      // Check for "Email not confirmed" error from Supabase.
      const errMsg = authError?.message ?? "";
      if (
        errMsg.toLowerCase().includes("not confirmed") ||
        errMsg.toLowerCase().includes("email not confirmed")
      ) {
        return NextResponse.json(
          {
            error:
              "Please confirm your email first. Check your inbox for the confirmation link we sent when you registered.",
            code: "EMAIL_NOT_CONFIRMED",
          },
          { status: 403 },
        );
      }
      // Check if the account exists in the DB but the auth user was deleted
      // in Supabase Dashboard. If so, clean up the orphaned accounts row
      // so the user can re-register.
      if (preCheck && !preCheck.supabaseAuthUid) {
        console.warn(
          `[login] ${email} exists in accounts but has no supabaseAuthUid - needs migration`,
        );
        return unauthorized(
          "Your account needs to be migrated. Use 'Forgot password' to set a new password, or contact your administrator.",
        );
      }
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
            return unauthorized(
              "Your account no longer exists. Please register again.",
            );
          }
        } catch {
          // Can't verify - fall through to the generic error.
        }
      }
      return unauthorized(
        "Incorrect email or password. Check your details and try again.",
      );
    }
    const authUid = authData.user.id;

    // Load the linked accounts row.
    const account = await db.account.findFirst({
      where: { supabaseAuthUid: authUid },
    });
    if (!account) {
      // Auth user exists but no accounts row - sign them out (inconsistent state).
      await supabase.auth.signOut();
      return unauthorized("Account not found. Contact your administrator.");
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
      await audit({
        actorId: account.id,
        action: "auth.account_activated",
        targetType: "Account",
        targetId: account.id,
        req,
      });
    }

    if (account.status === "SUSPENDED") {
      await supabase.auth.signOut();
      return NextResponse.json(
        {
          error:
            "Your account has been suspended. Please contact an administrator.",
          code: "SUSPENDED",
        },
        { status: 403 },
      );
    }

    // Anti-account-sharing: revoke previous refresh tokens (legacy field).
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
