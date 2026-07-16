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

// POST /api/auth/register
//
// Creates a Supabase Auth user + a linked accounts row (PENDING_VERIFICATION).
// Supabase sends a confirmation email automatically (one-time link with a
// configurable expiration). The user clicks the link -> /api/auth/callback
// exchanges the PKCE code -> account is activated.
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

    // RECONCILIATION: if the accounts row exists but has no supabaseAuthUid,
    // the auth user may have been deleted in Supabase Dashboard. Clean up
    // the orphaned accounts row so registration can proceed.
    if (
      existingEmail &&
      !existingEmail.supabaseAuthUid &&
      !existingEmail.isDeactivated
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

    // Create the Supabase Auth user (identity layer).
    // If Supabase has email confirmation enabled (default), signUp creates
    // the user with email_confirmed=false and sends a confirmation link.
    // The user cannot log in until they click that link.
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
    const authUid = authData.user.id;
    // If authData.session is null, email confirmation is pending.
    const needsEmailConfirmation = !authData.session;

    // Create the accounts row linked to the Supabase user (profile + RBAC).
    let account;
    try {
      account = await db.account.create({
        data: {
          email,
          passwordHash: "",
          fullName,
          role: "USER",
          status: "PENDING_VERIFICATION",
          studentId,
          program: program || (whitelisted?.program ?? null),
          section: section || (whitelisted?.section ?? null),
          supabaseAuthUid: authUid,
        },
      });
    } catch (e) {
      // Roll back the Supabase user if the accounts row fails.
      const adminClient = createSupabaseAdminClient();
      await adminClient.auth.admin.deleteUser(authUid).catch(() => {});
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
        status: "PENDING_VERIFICATION",
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
