import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { checkRateLimit, parseBody } from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";

const magicLinkSchema = z.object({
  email: z.string().email().max(255),
});

// POST /api/auth/magic-link
// Sends a passwordless sign-in link to the user's email (Supabase OTP).
// Enumeration-safe: same response whether or not the email exists.
// Auto-links pre-migration accounts (creates Supabase Auth user if needed).
export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      {
        error: "Authentication is not configured.",
        code: "AUTH_NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }
  const rl = await checkRateLimit(req, "otp");
  if (rl) return rl;

  const body = await parseBody(req);
  const parsed = magicLinkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({
      ok: true,
      message: "If an account exists, a sign-in link has been sent.",
    });
  }
  const { email } = parsed.data;

  // Auto-link pre-migration accounts (same logic as forgot-password).
  // Only ACTIVE or PENDING_VERIFICATION - not SUSPENDED (DoS prevention).
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
      }
    } catch (e) {
      console.error("[magic-link] auto-link failed:", e);
    }
  }

  const appUrl = req.nextUrl.origin;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: appUrl },
  });
  if (error) {
    console.error("[magic-link] signInWithOtp failed:", error.message);
  }

  await audit({
    actorId: null,
    action: "auth.magic_link_requested",
    targetType: "Account",
    metadata: { email },
    req,
  }).catch(() => {});

  return NextResponse.json({
    ok: true,
    message: "If an account exists, a sign-in link has been sent.",
  });
}
