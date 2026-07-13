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

    // Parse body FIRST so we can rate-limit by email (not IP).
    // Per-IP limiting blocks NAT'd campuses where 200+ students share one IP.
    const body = await parseBody(req);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const { email, password } = parsed.data;

    // Per-email rate limit (5/min). The DB lockout (5 fails → 15-min) is
    // the primary brute-force defense; this prevents enumeration attempts.
    const rl = await checkRateLimitByEmail(email, "login");
    if (rl) return rl;

    // ---- Pre-auth lockout check ----
    // Check if the account is locked BEFORE calling Supabase auth.
    // This prevents brute-force even if Supabase's own rate limit is bypassed.
    // Select only the fields needed here (avoids fetching notification_prefs
    // and other columns that may not exist if migrations aren't applied).
    const preCheck = await db.account.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        supabaseAuthUid: true,
        status: true,
        failedLoginAttempts: true,
        lockedUntil: true,
      },
    });
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

    // Per-account (user_id) checkpoint: now that we resolved the account by
    // email, throttle by account ID on top of the per-email limit. This
    // stops distributed brute force where an attacker rotates IPs/emails but
    // targets one account. Skipped if the email doesn't match an account
    // (the generic per-email limit still applies).
    if (preCheck) {
      const acctRl = await checkRateLimitByKey(preCheck.id, "loginAccount");
      if (acctRl) return acctRl;
    }

    // Sign in via Supabase Auth (sets the session cookie).
    const supabase = await createSupabaseServerClient();
    const { data: authData, error: authError } =
      await supabase.auth.signInWithPassword({
        email,
        password,
      });

    if (authError || !authData.user) {
      // ---- Increment failed login attempts (atomic) ----
      // Use Prisma's atomic increment to close the race where two
      // concurrent failed logins both read the same count and both write
      // count+1, bypassing the 5-attempt lockout.
      if (preCheck) {
        const updated = await db.account
          .update({
            where: { id: preCheck.id },
            data: {
              failedLoginAttempts: { increment: 1 },
            },
            select: { failedLoginAttempts: true },
          })
          .catch(() => null);
        if (updated && updated.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
          // Lock the account. Separate update to avoid overwriting
          // lockedUntil on every attempt past the threshold.
          await db.account
            .update({
              where: { id: preCheck.id },
              data: { lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) },
            })
            .catch(() => {});
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
        // Keep this distinct message: an unconfirmed-email user genuinely
        // needs a different remediation than a wrong password. The email
        // existence is already implied by the registration flow.
        return NextResponse.json(
          {
            error:
              "Please confirm your email first. Check your inbox for the confirmation link we sent when you registered.",
            code: "EMAIL_NOT_CONFIRMED",
          },
          { status: 403 },
        );
      }
      // Orphan-reconciliation: if the accounts row exists but the Supabase
      // auth user was deleted (e.g. via dashboard), clean up silently and
      // return the SAME generic error so an attacker can't enumerate which
      // emails have orphan rows.
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
      // Generic message for all other failures (wrong password, no account,
      // migration needed). Prevents account enumeration.
      return unauthorized(
        "Incorrect email or password. Check your details and try again.",
      );
    }
    const authUid = authData.user.id;

    // Load the linked accounts row.
    // Load the linked accounts row (select only needed fields to avoid
    // fetching columns that may not exist if migrations aren't applied).
    const account = await db.account.findFirst({
      where: { supabaseAuthUid: authUid },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        status: true,
        studentId: true,
        program: true,
        section: true,
      },
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
