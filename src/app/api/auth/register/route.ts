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
import {
  safeFindAccountByEmail,
  isAccountDeactivated,
} from "@/lib/safe-account";
import { getAppUrl } from "@/lib/app-url";

// POST /api/auth/register
//
// Creates a Supabase Auth user + a linked accounts row (PENDING_VERIFICATION).
// Supabase sends a confirmation email automatically.
//
// ENUMERATION-SAFE DESIGN:
//   If the email already exists, this endpoint returns the SAME success
//   response as a new registration ("Check your email to confirm your
//   account"). The existing user receives a "sign-in link" email instead
//   of a confirmation email, so they can log in without revealing that
//   their account exists. An attacker cannot distinguish new vs existing.
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

    // Check for existing email (safe lookup).
    const existingEmail = await safeFindAccountByEmail(email);

    // ---- ENUMERATION-SAFE PATH: existing email ----
    // If the email exists and is NOT deactivated, send a sign-in link to
    // the existing user and return the same success response as a new
    // registration. The attacker can't tell if the account exists.
    if (existingEmail && !isAccountDeactivated(existingEmail)) {
      // Send a magic-link sign-in email so the legitimate owner can log in.
      try {
        const supabase = await createSupabaseServerClient();
        const appUrl = getAppUrl() || req.nextUrl.origin;
        await supabase.auth.signInWithOtp({
          email,
          options: {
            emailRedirectTo: appUrl,
            shouldCreateUser: false,
          },
        });
      } catch (e) {
        console.error("[register] sign-in link for existing email failed:", e);
      }

      await audit({
        actorId: existingEmail.id,
        action: "auth.register_duplicate_attempt",
        targetType: "Account",
        metadata: { email, studentId, reason: "email_exists_enu_safe" },
        req,
      }).catch(() => {});

      // Return the SAME success response as a new registration.
      return NextResponse.json(
        {
          ok: true,
          message:
            "Account created! Check your email to confirm your account, then sign in.",
          email,
          whitelisted: false,
          needsEmailConfirmation: true,
        },
        { status: 201, headers: { "Cache-Control": "no-store" } },
      );
    }

    // If the existing email account is deactivated, allow re-registration
    // by removing the soft-deleted row AND the linked Supabase auth user.
    if (existingEmail && isAccountDeactivated(existingEmail)) {
      if (existingEmail.supabaseAuthUid) {
        try {
          const adminClient = createSupabaseAdminClient();
          await adminClient.auth.admin
            .deleteUser(existingEmail.supabaseAuthUid)
            .catch(() => {});
        } catch {
          // Non-critical.
        }
      }
      await db.account
        .delete({ where: { id: existingEmail.id } })
        .catch(() => {});
    }

    // RECONCILIATION: orphaned accounts row (no supabaseAuthUid).
    if (
      existingEmail &&
      !existingEmail.supabaseAuthUid &&
      !isAccountDeactivated(existingEmail)
    ) {
      try {
        const rows = await db.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM auth.users WHERE email = ${email} LIMIT 1
        `;
        if (rows.length === 0) {
          await db.account.delete({ where: { id: existingEmail.id } });
        }
      } catch (e) {
        console.error("[register] reconciliation check failed:", e);
      }
    }

    // Check student ID (still returns generic error - student IDs are not
    // as sensitive as emails, and the student ID is already known to the
    // student so there's no enumeration risk).
    const existingStudentId = await db.account.findUnique({
      where: { studentId },
      select: { id: true },
    });
    if (existingStudentId) {
      await audit({
        actorId: null,
        action: "auth.register_duplicate_attempt",
        targetType: "Account",
        metadata: { email, studentId, reason: "studentId_exists" },
        req,
      }).catch(() => {});
      return badRequest(
        "This student ID is already in use. If this is your ID, try signing in or contact your administrator.",
        "REGISTRATION_FAILED",
      );
    }

    const whitelisted = await db.authorizedStudent.findUnique({
      where: { studentId },
    });
    const isWhitelisted = !!whitelisted;

    // Create the Supabase Auth user.
    const supabase = await createSupabaseServerClient();
    const appUrl = getAppUrl() || req.nextUrl.origin;
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { fullName }, emailRedirectTo: appUrl },
    });
    if (authError || !authData.user) {
      // If Supabase says "already registered", the email exists in Supabase
      // but not in our accounts table. Return the same success response to
      // avoid enumeration (the user gets a sign-in link via the OTP path
      // above on their next attempt, or they can use forgot-password).
      const msg = authError?.message ?? "";
      if (
        msg.toLowerCase().includes("already registered") ||
        msg.toLowerCase().includes("user already")
      ) {
        return NextResponse.json(
          {
            ok: true,
            message:
              "Account created! Check your email to confirm your account, then sign in.",
            email,
            whitelisted: isWhitelisted,
            needsEmailConfirmation: true,
          },
          { status: 201, headers: { "Cache-Control": "no-store" } },
        );
      }
      return badRequest(
        "Unable to create account. Please try again.",
        "REGISTRATION_FAILED",
      );
    }
    const authUid = authData.user.id;
    const needsEmailConfirmation = !authData.session;

    // Create the accounts row.
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

    // Build the success message.
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
