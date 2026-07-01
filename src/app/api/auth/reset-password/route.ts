import { NextRequest, NextResponse } from "next/server";
import { resetPasswordSchema } from "@/lib/validation";
import { badRequest, checkRateLimit, getClientIp, parseBody } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { getCurrentAccountSupabase } from "@/lib/supabase-session";

// POST /api/auth/reset-password
// Sets a new password via Supabase Auth. Requires an active recovery
// session (established client-side when the user clicks the email link).
export async function POST(req: NextRequest) {
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

  // The recovery session must be active (user clicked the email link).
  const account = await getCurrentAccountSupabase();
  if (!account) {
    return badRequest(
      "This reset link is invalid or has expired. Please request a new one.",
      "INVALID_TOKEN",
    );
  }

  const supabase = await createSupabaseServerClient();
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
