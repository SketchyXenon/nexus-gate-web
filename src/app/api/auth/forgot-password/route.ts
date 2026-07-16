// Allow up to 15s for Supabase Auth round-trips (Hobby default is 10s).
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forgotPasswordSchema } from "@/lib/validation";
import {
  checkRateLimit,
  parseBody,
  getClientIp,
  dbUnavailable,
  isDbUnavailableError,
} from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
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

// POST /api/auth/forgot-password
// Sends a Supabase password-reset email. Enumeration-safe (same response
// whether or not the email exists). Also auto-links pre-migration accounts:
// if the email exists in accounts but not in Supabase Auth, creates the
// auth user + links it, then sends the reset email.
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
    const rl = await checkRateLimit(req, "otp");
    if (rl) return rl;

    const ip = getClientIp(req);
    const ipResult = await rateLimit(`forgotpw-strict:ip:${ip}`, "otp");
    if (!ipResult.allowed) {
      return NextResponse.json(
        {
          error:
            "Too many password reset requests from this network. Please try again later.",
          code: "IP_RATE_LIMITED",
        },
        { status: 429 },
      );
    }

    const body = await parseBody(req);
    const parsed = forgotPasswordSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: true,
          message:
            "If an account with that email exists, a reset link has been sent.",
        },
        { status: 200 },
      );
    }
    const { email, redirectTo } = parsed.data;

    const supabase = await createSupabaseServerClient();

    // Check if the account exists in our DB but has no Supabase Auth link.
    // Only auto-link ACTIVE or PENDING_VERIFICATION accounts, and NOT
    // deactivated ones - prevents a deactivated user from bypassing
    // deactivation via password-reset auto-link.
    const dbAccount = await safeFindAccountByEmail(email, {
      fullName: true,
    });
    if (
      dbAccount &&
      !dbAccount.supabaseAuthUid &&
      !isAccountDeactivated(dbAccount) &&
      (dbAccount.status === "ACTIVE" ||
        dbAccount.status === "PENDING_VERIFICATION")
    ) {
      try {
        const admin = createSupabaseAdminClient();
        const { data: authData, error: authError } =
          await admin.auth.admin.createUser({
            email,
            email_confirm: true,
            user_metadata: { fullName: dbAccount.fullName },
          });
        if (!authError && authData.user) {
          await db.account.update({
            where: { id: dbAccount.id },
            data: { supabaseAuthUid: authData.user.id },
          });
          console.log(
            `[forgot-password] auto-linked ${email} to Supabase Auth user ${authData.user.id}`,
          );
        }
      } catch (e) {
        console.error(`[forgot-password] auto-link failed for ${email}:`, e);
      }
    }

    // Send the password-reset email via Supabase. Use the client-supplied
    // redirectTo if provided and valid (same-origin, verified by Zod), else
    // fall back to the app URL. Relative paths (e.g. "/reset") are resolved
    // against the app URL to produce an absolute URL for Supabase.
    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL?.trim() || req.nextUrl.origin;
    let finalRedirectTo = appUrl;
    if (redirectTo) {
      if (redirectTo.startsWith("/")) {
        finalRedirectTo = new URL(redirectTo, appUrl).toString();
      } else {
        finalRedirectTo = redirectTo;
      }
    }
    // Note: the OTP expiry (single-use + time limit) is enforced by Supabase
    // Auth. Configure in Supabase Dashboard → Auth → Configuration → OTP
    // Settings → OTP Expiry. Recommended: 600s (10 min). The code is
    // consumed on first use (exchangeCodeForSession) and cannot be replayed.
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email,
      {
        redirectTo: finalRedirectTo,
      },
    );
    if (resetError) {
      console.error(
        `[forgot-password] resetPasswordForEmail failed for ${email}:`,
        resetError.message,
      );
    }

    await audit({
      actorId: null,
      action: "auth.password_reset_requested",
      targetType: "Account",
      metadata: { email },
      req,
    }).catch(() => {});

    return NextResponse.json(
      {
        ok: true,
        message:
          "If an account with that email exists, a reset link has been sent.",
      },
      { status: 200 },
    );
  } catch (e) {
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    throw e;
  }
}
