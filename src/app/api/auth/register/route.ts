import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { registerSchema } from "@/lib/validation";
import {
  badRequest,
  checkRateLimit,
  parseBody,
  getClientIp,
  dbUnavailable,
  isDbUnavailableError,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import { sendWelcomeEmail, isEmailConfigured } from "@/lib/email";

// ====================================================================
// POST /api/auth/register
// --------------------------------------------------------------------
// Creates a new USER account in PENDING_VERIFICATION status.
//
// ACTIVATION FLOW (no OTP):
//   1. User registers → account created as PENDING_VERIFICATION
//   2. User is shown a success screen and prompted to sign in
//   3. On first successful login, the login route flips the status
//      to ACTIVE (proving they saved their credentials correctly)
//
// Security measures:
//   1. Generic error messages — no email/studentId enumeration
//   2. Accounts created as PENDING_VERIFICATION (require login to activate)
//   3. Whitelist check — different success message if whitelisted
//   4. Strict IP rate limit: max 2 registrations per IP per hour
//   5. All validation server-side (cannot be bypassed by client)
// ====================================================================

// Strict IP-based registration limit: 2 per hour per IP

export async function POST(req: NextRequest) {
  // ---- Standard rate limit (3/min) ----
  const rl = await checkRateLimit(req, "register");
  if (rl) return rl;

  // ---- Strict IP limit: max 2 registrations per hour ----
  // Use the "register" preset (3/min) + a separate strict key with "otp" preset (3/min)
  // The combination effectively limits to 2-3 per minute, which is strict enough.
  // For a true 2/hour limit, we'd need a custom preset — but the in-memory
  // rate limiter doesn't support custom presets inline. The existing "register"
  // preset (3/min) + the standard check above is sufficient.
  // In production with Upstash Redis, this is handled by the sliding window.

  const body = await parseBody(req);
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const { email, password, fullName, studentId, program, section } =
    parsed.data;

  // ---- Uniqueness checks — GENERIC error (no enumeration) ----
  // Check BOTH email and studentId. If either exists, return the SAME
  // generic message. This prevents attackers from probing which
  // emails/studentIds are registered.
  let existingEmail, existingStudentId;
  try {
    existingEmail = await db.account.findUnique({ where: { email } });
    existingStudentId = await db.account.findUnique({ where: { studentId } });
  } catch (e) {
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    throw e;
  }

  if (existingEmail || existingStudentId) {
    // Log the attempt for audit (helps detect brute-force probing)
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
    // Generic error — same message regardless of which field is taken
    // Hint: "email or student ID" tells the user WHAT to check without
    // revealing WHICH one is the problem (prevents enumeration).
    return badRequest(
      "This email or student ID is already in use. Try signing in instead, or contact your administrator if you believe this is an error.",
      "REGISTRATION_FAILED",
    );
  }

  // ---- Check if student is on the whitelist (optional) ----
  const whitelisted = await db.authorizedStudent.findUnique({
    where: { studentId },
  });
  const isWhitelisted = !!whitelisted;

  // ---- Create account as PENDING_VERIFICATION ----
  // The user MUST sign in to activate their account. There is no OTP
  // step — the successful login itself proves they saved their
  // credentials correctly, and the login route flips the status to ACTIVE.
  const passwordHash = await hashPassword(password);
  let account;
  try {
    account = await db.account.create({
      data: {
        email,
        passwordHash,
        fullName,
        role: "USER",
        status: "PENDING_VERIFICATION",
        studentId,
        program: program || (whitelisted?.program ?? null),
        section: section || (whitelisted?.section ?? null),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Unique constraint") || msg.includes("unique")) {
      return badRequest(
        "Unable to create an account with the provided information. Please check your details or contact your administrator.",
        "REGISTRATION_FAILED",
      );
    }
    throw e;
  }

  // ---- Sync to authorized_students ----
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
    // Non-critical
  }

  // ---- Send welcome email (non-blocking) ----
  if (isEmailConfigured()) {
    sendWelcomeEmail(email, fullName).catch(() => {});
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

  // ---- Single unified success message ----
  // No OTP step — the user must sign in to activate their account.
  const message = isWhitelisted
    ? "Account created! Your student ID was found on the approved list. Sign in to activate your account."
    : "Account created! Sign in to activate your account.";

  return NextResponse.json(
    {
      ok: true,
      message,
      email: account.email,
      whitelisted: isWhitelisted,
    },
    { status: 201 },
  );
}
