import { NextRequest, NextResponse } from "next/server";
import { resetPasswordSchema } from "@/lib/validation";
import { badRequest, checkRateLimit, getClientIp, parseBody } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import {
  createSupabaseServerClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";
import { getCurrentAccountSupabase } from "@/lib/supabase-session";

// POST /api/auth/reset-password
// Sets a new password via Supabase Auth. Requires an active RECOVERY session
// (established client-side when the user clicks the email link). A regular
// login session is NOT accepted - this prevents a stolen session from being
// used to change the password without knowing the current one.
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
  const ipResult = await rateLimit(`resetpw-strict:ip:${ip}`, "otp");
  if (!ipResult.allowed) {
    return NextResponse.json(
      {
        error:
          "Too many password reset attempts from this network. Please try again later.",
        code: "IP_RATE_LIMITED",
      },
      { status: 429 },
    );
  }

  const body = await parseBody(req);
  const parsed = resetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      parsed.error.issues[0]?.message ?? "Invalid input",
      "INVALID_TOKEN",
    );
  }
  const { password } = parsed.data;

  // Verify the session is a RECOVERY session (not a regular login).
  // Supabase sets the `user_metadata` to include a recovery flag, and the
  // session's AMR (Authentication Methods Reference) includes "recovery".
  // We check the JWT's amr claim - if it doesn't contain "recovery", reject.
  const supabase = await createSupabaseServerClient();
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) {
    return badRequest(
      "This reset link is invalid or has expired. Please request a new one.",
      "INVALID_TOKEN",
    );
  }

  // Check the AMR claim for a RECOVERY authentication method ONLY.
  // Do NOT accept "otp" - that's a magic-link LOGIN session, not a recovery
  // session. Accepting "otp" would let a stolen magic-link session change
  // the victim's password (temporary compromise becomes persistent takeover).
  const payload = JSON.parse(
    Buffer.from(
      sessionData.session.access_token.split(".")[1],
      "base64",
    ).toString("utf-8"),
  ) as { amr?: Array<{ method: string }> };
  const amr = payload.amr;
  const isRecoverySession = amr?.some((entry) => entry.method === "recovery");
  if (!isRecoverySession) {
    // Not a recovery session - reject. Only password-reset email links count.
    return badRequest(
      "This action requires a password-reset link. Please request a new one.",
      "INVALID_TOKEN",
    );
  }

  const account = await getCurrentAccountSupabase();
  if (!account) {
    return badRequest(
      "This reset link is invalid or has expired. Please request a new one.",
      "INVALID_TOKEN",
    );
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return badRequest(
      "Unable to reset password. Please request a new reset link.",
      "INVALID_TOKEN",
    );
  }

  await audit({
    actorId: account.id,
    action: "auth.password_reset",
    targetType: "Account",
    targetId: account.id,
    req,
  }).catch(() => {});

  return NextResponse.json({
    ok: true,
    message:
      "Your password has been reset. You can now sign in with your new password.",
  });
}
