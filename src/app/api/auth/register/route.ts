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
import { requireTurnstile } from "@/lib/turnstile";
import { createSupabaseServerClient } from "@/lib/supabase-server";

// POST /api/auth/register
// Creates a Supabase Auth user + a linked accounts row (PENDING_VERIFICATION).
// The user must sign in to activate (login flips status to ACTIVE).
export async function POST(req: NextRequest) {
  try {
    const rl = await checkRateLimit(req, "register");
    if (rl) return rl;

    const body = await parseBody<{ cfToken?: string }>(req);
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const { email, password, fullName, studentId, program, section } =
      parsed.data;

    const turnstileError = await requireTurnstile(req, body);
    if (turnstileError) return turnstileError;

    // Uniqueness checks - generic error (no enumeration).
    const existingEmail = await db.account.findUnique({ where: { email } });
    const existingStudentId = await db.account.findUnique({
      where: { studentId },
    });
    if (existingEmail || existingStudentId) {
      await audit({
        actorId: null,
        action: "auth.register_duplicate_attempt",
        targetType: "Account",
        metadata: {
          email,
          studentId,
          reason: existingEmail ? "email_exists" : "studentId_exists",
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

    // 1. Create the Supabase Auth user (identity layer).
    const supabase = await createSupabaseServerClient();
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { fullName } },
    });
    if (authError || !authData.user) {
      // Map Supabase errors to generic messages (no enumeration).
      const msg = authError?.message ?? "Registration failed";
      if (
        msg.toLowerCase().includes("already registered") ||
        msg.toLowerCase().includes("user already")
      ) {
        return badRequest(
          "This email or student ID is already in use. Try signing in instead.",
          "REGISTRATION_FAILED",
        );
      }
      return badRequest(
        "Unable to create account. Please try again.",
        "REGISTRATION_FAILED",
      );
    }
    const authUid = authData.user.id;

    // 2. Create the accounts row linked to the Supabase user (profile + RBAC).
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
      const admin = await createSupabaseServerClient();
      await admin.auth.admin.deleteUser(authUid).catch(() => {});
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

    const message = isWhitelisted
      ? "Account created! Your student ID was found on the approved list. Sign in to activate your account."
      : "Account created! Sign in to activate your account.";

    return NextResponse.json(
      { ok: true, message, email: account.email, whitelisted: isWhitelisted },
      { status: 201 },
    );
  } catch (e) {
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    throw e;
  }
}
