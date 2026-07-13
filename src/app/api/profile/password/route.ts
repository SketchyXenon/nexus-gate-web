// Allow up to 15s for Supabase re-auth + password update.
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { changePasswordSchema } from "@/lib/validation";
import { badRequest, forbidden, parseBody, requireAuth, unauthorized } from "@/lib/api";
import { audit } from "@/lib/audit";
import { isCooldownExpired, daysUntilCooldownExpires } from "@/lib/cooldown";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { getCurrentAccountSupabase } from "@/lib/supabase-session";

// POST /api/profile/password - change own password via Supabase Auth.
// Requires the current password for verification (re-authentication).
// 30-day cooldown enforced via the accounts table.
export async function POST(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  const body = await parseBody(req);
  const parsed = changePasswordSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const { currentPassword, newPassword } = parsed.data;

  const fullAccount = await db.account.findUnique({
    where: { id: account.id },
    select: { email: true, authProvider: true, lastPasswordChangeAt: true },
  });
  if (!fullAccount) return unauthorized();

  // 30-day cooldown (first change is exempt).
  if (!isCooldownExpired(fullAccount.lastPasswordChangeAt)) {
    const daysLeft = daysUntilCooldownExpires(fullAccount.lastPasswordChangeAt);
    return forbidden(
      `You can change your password again in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`,
      "PASSWORD_COOLDOWN"
    );
  }

  // OAuth-only accounts (no password yet) can set one without currentPassword.
  const isOAuthOnly = Boolean(fullAccount.authProvider);
  if (!isOAuthOnly) {
    // Re-verify the current password via Supabase before allowing the change.
    const supabase = await createSupabaseServerClient();
    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email: fullAccount.email,
      password: currentPassword,
    });
    if (verifyError) {
      return badRequest("Your current password is incorrect.", "WRONG_PASSWORD");
    }
  }

  // Update the password via Supabase Auth.
  const supabase = await createSupabaseServerClient();
  const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
  if (updateError) {
    return badRequest("Unable to update password. Please try again.", "UPDATE_FAILED");
  }

  // Stamp lastPasswordChangeAt (drives the cooldown).
  await db.account.update({
    where: { id: account.id },
    data: { lastPasswordChangeAt: new Date() },
  });

  await audit({
    actorId: account.id, action: "profile.password_change", targetType: "Account",
    targetId: account.id, req,
  });

  return NextResponse.json({
    ok: true,
    message: "Password updated. You'll need to sign in again on other devices.",
    canChangePassword: false,
    daysUntilPasswordChange: 30,
  });
}
