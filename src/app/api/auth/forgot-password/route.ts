import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forgotPasswordSchema } from "@/lib/validation";
import { checkRateLimit, parseBody, getClientIp } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";

// POST /api/auth/forgot-password
// Sends a Supabase password-reset email. Enumeration-safe (same response
// whether or not the email exists). Also auto-links pre-migration accounts:
// if the email exists in accounts but not in Supabase Auth, creates the
// auth user + links it, then sends the reset email.
export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      {
        error: "Authentication is not configured. Contact your administrator.",
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
  // Only auto-link ACTIVE or PENDING_VERIFICATION accounts - not SUSPENDED
  // (an attacker could otherwise create auth users for suspended accounts,
  // locking the victim out of password login until they complete the email flow).
  const dbAccount = await db.account.findUnique({ where: { email } });
  if (
    dbAccount &&
    !dbAccount.supabaseAuthUid &&
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

  // Send the password-reset email via Supabase.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const { error: resetError } = await supabase.auth.resetPasswordForEmail(
    email,
    {
      redirectTo: appUrl,
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
}
