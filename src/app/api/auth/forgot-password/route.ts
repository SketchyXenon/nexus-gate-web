import { NextRequest, NextResponse } from "next/server";
import { forgotPasswordSchema } from "@/lib/validation";
import { checkRateLimit, parseBody, getClientIp } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import {
  createSupabaseServerClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";

// POST /api/auth/forgot-password
// Sends a Supabase password-reset email. Enumeration-safe (same response
// whether or not the email exists).
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
  const { email } = parsed.data;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const supabase = await createSupabaseServerClient();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: appUrl,
  });

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
