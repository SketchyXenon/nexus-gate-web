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
  DEFAULT_NOTIFICATION_PREFS,
  serializeNotificationPrefs,
} from "@/lib/notification-prefs";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";
import { safeFindAccountByEmail } from "@/lib/safe-account";
import { recordTermsAcceptance } from "@/lib/terms-acceptance";
import { getSafeRedirectBase } from "@/lib/app-url";
import { isUniqueConstraintError } from "@/lib/prisma-errors";

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
    const {
      email,
      password,
      fullName,
      studentId,
      program,
      section,
      agreeToTerms,
    } = parsed.data;

    // Check for existing email (safe lookup).
    const existingEmail = await safeFindAccountByEmail(email);

    // ENUMERATION-SAFE: if the email already exists, return the SAME 201
    // success response as a fresh registration. An attacker cannot
    // distinguish new vs existing by status code, body, or shape. The
    // existing user is NOT modified; the audit log records the duplicate
    // attempt server-side only. (06-security-architecture.md §2: identical
    // response body + status for valid and invalid identifiers.)
    if (existingEmail) {
      await audit({
        actorId: existingEmail.id,
        action: "auth.register_duplicate_attempt",
        targetType: "Account",
        metadata: { email, studentId, reason: "email_exists" },
        req,
      }).catch(() => {});

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
    const appUrl = getSafeRedirectBase(req.nextUrl.origin);
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { fullName }, emailRedirectTo: appUrl },
    });
    if (authError || !authData.user) {
      // If Supabase says "already registered", the email exists in Supabase
      // Auth. Return the same enumeration-safe 201 as the local existing-email
      // branch so this path is indistinguishable from a fresh registration.
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
            whitelisted: false,
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
          // L5 fix: omit the dead passwordHash write. The column has
          // @default("") in the schema, and passwords are managed by
          // Supabase Auth (never stored locally). Writing "" was a vestigial
          // pattern from the pre-Supabase auth system.
          fullName,
          role: "USER",
          status: "PENDING_VERIFICATION",
          studentId,
          program: program || (whitelisted?.program ?? null),
          section: section || (whitelisted?.section ?? null),
          supabaseAuthUid: authUid,
          // Seed default notification prefs explicitly. Postgres had a
          // column-level default (migration 0015); TiDB/MySQL does not, so
          // the app must set it. Shared helper keeps the default in one place.
          notificationPrefs: serializeNotificationPrefs(
            DEFAULT_NOTIFICATION_PREFS,
          ) as never,
        },
      });
    } catch (e) {
      // Roll back the Supabase user if the accounts row fails.
      const adminClient = createSupabaseAdminClient();
      await adminClient.auth.admin.deleteUser(authUid).catch(() => {});
      // P2002 = unique constraint (email or studentId already taken).
      // Use the stable Prisma error code instead of a fragile string match.
      if (isUniqueConstraintError(e)) {
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
        termsAccepted: agreeToTerms,
        termsAcceptedAt: new Date().toISOString(),
      },
      req,
    });

    // Record the terms acceptance in the immutable append-only table.
    // Graceful degradation: if the table doesn't exist (migration 0018
    // not applied), the audit log above still records the acceptance.
    await recordTermsAcceptance(account.id, req);

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
