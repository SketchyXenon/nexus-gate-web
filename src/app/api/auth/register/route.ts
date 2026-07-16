// Allow up to 15s for Supabase Auth round-trips (Hobby default is 10s).
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { registerSchema } from "@/lib/validation";
import {
  badRequest,
  checkRateLimit,
  parseBody,
  dbUnavailable,
  isDbUnavailableError,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";
import { hashPassword } from "@/lib/auth";
import { sendWelcomeEmail } from "@/lib/email";

// POST /api/auth/register
//
// Production: calls supabase.auth.signUp() which creates the auth user AND
// sends Supabase's built-in confirmation email (one-time link with a
// configurable expiration, default 24h). The user clicks the link ->
// /api/auth/callback exchanges the PKCE code -> account is activated.
//
// Dev mode (no Supabase configured): auto-activates the account since
// there is no email service. The user can sign in immediately.
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
    const rl = await checkRateLimit(req, "register");
    if (rl) return rl;

    const body = await parseBody(req);
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const { email, password, fullName, studentId, program, section } =
      parsed.data;

    // Uniqueness checks - generic error (no enumeration).
    const existingEmail = await db.account.findUnique({
      where: { email },
      select: { id: true, supabaseAuthUid: true, isDeactivated: true },
    });
    const existingStudentId = await db.account.findUnique({
      where: { studentId },
      select: { id: true },
    });

    // If the existing email account is deactivated, allow re-registration
    // by removing the soft-deleted row (the user explicitly left).
    if (existingEmail?.isDeactivated) {
      await db.account
        .delete({ where: { id: existingEmail.id } })
        .catch(() => {});
    }

    // RECONCILIATION (production only): orphaned accounts row cleanup.
    if (
      !isDevAuthMode() &&
      existingEmail &&
      !existingEmail.supabaseAuthUid &&
      !existingEmail.isDeactivated &&
      isSupabaseConfigured()
    ) {
      try {
        const rows = await db.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM auth.users WHERE email = ${email} LIMIT 1
        `;
        if (rows.length === 0) {
          console.log(
            `[register] cleaning orphaned accounts row for ${email} (no auth user found)`,
          );
          await db.account.delete({ where: { id: existingEmail.id } });
        }
      } catch (e) {
        console.error("[register] reconciliation check failed:", e);
      }
    }

    // Re-check after potential cleanup.
    const existingEmailAfter = existingEmail?.supabaseAuthUid
      ? existingEmail
      : await db.account.findUnique({
          where: { email },
          select: { id: true, supabaseAuthUid: true },
        });
    if (existingEmailAfter || existingStudentId) {
      await audit({
        actorId: null,
        action: "auth.register_duplicate_attempt",
        targetType: "Account",
        metadata: {
          email,
          studentId,
          reason: existingEmailAfter ? "email_exists" : "studentId_exists",
        },
        req,
      }).catch(() => {});
      return badRequest(
        "This email or student ID is already in use. Try signing in instead, or contact your administrator if you believe this is an error.",
        "REGISTRATION_FAILED",
      );
    }

    const whitelisted = await db.authorizedStudent.findUnique({
      where: { studentId },
    });
    const isWhitelisted = !!whitelisted;

    // ---- Create the auth identity + accounts row ----
    let authUid: string | null = null;
    let needsEmailConfirmation = true;
    let passwordHash = "";

    if (isDevAuthMode()) {
      // Dev mode: hash the password with bcrypt, no Supabase user.
      // Auto-activate since there is no email service to verify with.
      passwordHash = await hashPassword(password);
      needsEmailConfirmation = false;
    } else {
      // Production: create the Supabase Auth user.
      // Supabase sends a confirmation email automatically (one-time link,
      // expires per dashboard config). The user clicks it -> callback
      // exchanges the PKCE code -> account is activated.
      const supabase = await createSupabaseServerClient();
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL?.trim() || req.nextUrl.origin;
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { fullName }, emailRedirectTo: appUrl },
      });
      if (authError || !authData.user) {
        const msg = authError?.message ?? "Registration failed";
        if (
          msg.toLowerCase().includes("already registered") ||
          msg.toLowerCase().includes("user already")
        ) {
          return badRequest(
            "This email is already registered. Try signing in instead, or use 'Forgot password' if you can't log in.",
            "REGISTRATION_FAILED",
          );
        }
        return badRequest(
          "Unable to create account. Please try again.",
          "REGISTRATION_FAILED",
        );
      }
      authUid = authData.user.id;
      // If Supabase returns a session, email confirmation is disabled.
      needsEmailConfirmation = !authData.session;
    }

    // Create the accounts row.
    let account;
    try {
      account = await db.account.create({
        data: {
          email,
          passwordHash,
          fullName,
          role: "USER",
          status: isDevAuthMode() ? "ACTIVE" : "PENDING_VERIFICATION",
          emailVerifiedAt: isDevAuthMode() ? new Date() : null,
          studentId,
          program: program || (whitelisted?.program ?? null),
          section: section || (whitelisted?.section ?? null),
          supabaseAuthUid: authUid,
        },
      });
    } catch (e) {
      // Roll back the Supabase user if the accounts row fails.
      if (!isDevAuthMode() && authUid) {
        const adminClient = createSupabaseAdminClient();
        await adminClient.auth.admin.deleteUser(authUid).catch(() => {});
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Unique constraint") || msg.includes("unique")) {
        return badRequest(
          "Unable to create an account with the provided information. Please check your details or contact your administrator.",
          "REGISTRATION_FAILED",
        );
      }
      throw e;
    }

    // Sync to authorized_students (non-critical).
    try {
      await db.authorizedStudent.upsert({
        where: { studentId },
        update: {
          email,
          fullName,
          program: program || whitelisted?.program || "",
          section: section || whitelisted?.section || "",
          activated: false,
        },
        create: {
          studentId,
          email,
          fullName,
          program: program || "",
          section: section || "",
          activated: false,
        },
      });
    } catch {
      // Non-critical.
    }

    await audit({
      actorId: account.id,
      action: "auth.register",
      targetType: "Account",
      targetId: account.id,
      metadata: {
        email,
        studentId,
        whitelisted: isWhitelisted,
        status: account.status,
        devMode: isDevAuthMode(),
      },
      req,
    });

    // Build the success message based on whether email confirmation is needed.
    let message: string;
    if (needsEmailConfirmation) {
      message = isWhitelisted
        ? "Account created! Your student ID was found on the approved list. Check your email to confirm your account, then sign in."
        : "Account created! Check your email to confirm your account, then sign in.";
    } else {
      message = isWhitelisted
        ? "Account created! Your student ID was found on the approved list. Sign in to activate your account."
        : "Account created! Sign in to activate your account.";
    }

    return NextResponse.json(
      {
        ok: true,
        message,
        email: account.email,
        whitelisted: isWhitelisted,
        needsEmailConfirmation,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    throw e;
  }
}
