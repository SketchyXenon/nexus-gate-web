import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { loginSchema } from "@/lib/validation";
import {
  badRequest,
  checkRateLimit,
  parseBody,
  unauthorized,
  dbUnavailable,
  isDbUnavailableError,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";

// POST /api/auth/login
// Signs in via Supabase Auth, then activates PENDING_VERIFICATION accounts.
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
    const rl = await checkRateLimit(req, "login");
    if (rl) return rl;

    const body = await parseBody(req);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const { email, password } = parsed.data;

    // Sign in via Supabase Auth (sets the session cookie).
    const supabase = await createSupabaseServerClient();
    const { data: authData, error: authError } =
      await supabase.auth.signInWithPassword({
        email,
        password,
      });
    if (authError || !authData.user) {
      // Check if the account exists in the DB but the auth user was deleted
      // in Supabase Dashboard. If so, clean up the orphaned accounts row
      // so the user can re-register.
      const dbAccount = await db.account.findUnique({ where: { email } });
      if (dbAccount && !dbAccount.supabaseAuthUid) {
        // Pre-migration account (no auth link) — tell them to use forgot-password.
        console.warn(
          `[login] ${email} exists in accounts but has no supabaseAuthUid - needs migration`,
        );
        return unauthorized(
          "Your account needs to be migrated. Use 'Forgot password' to set a new password, or contact your administrator.",
        );
      }
      if (dbAccount && dbAccount.supabaseAuthUid && isSupabaseConfigured()) {
        // The accounts row has a supabaseAuthUid but signInWithPassword failed.
        // The auth user may have been deleted in Supabase Dashboard. Verify.
        try {
          const admin = createSupabaseAdminClient();
          const { data: userData } = await admin.auth.admin.getUserById(
            dbAccount.supabaseAuthUid,
          );
          if (!userData?.user) {
            // Auth user is gone — clean up the orphaned accounts row.
            console.log(
              `[login] cleaning orphaned accounts row for ${email} (auth user deleted)`,
            );
            await db.account.delete({ where: { id: dbAccount.id } });
            return unauthorized(
              "Your account no longer exists. Please register again.",
            );
          }
        } catch {
          // Can't verify — fall through to the generic error.
        }
      }
      return unauthorized(
        "Incorrect email or password. Check your details and try again.",
      );
    }
    const authUid = authData.user.id;

    // Load the linked accounts row.
    const account = await db.account.findFirst({
      where: { supabaseAuthUid: authUid },
    });
    if (!account) {
      // Auth user exists but no accounts row - sign them out (inconsistent state).
      await supabase.auth.signOut();
      return unauthorized("Account not found. Contact your administrator.");
    }

    // Locked account check.
    if (account.lockedUntil && account.lockedUntil > new Date()) {
      const retryMs = account.lockedUntil.getTime() - Date.now();
      await supabase.auth.signOut();
      return NextResponse.json(
        {
          error: `Too many failed attempts. Please try again in ${Math.ceil(retryMs / 1000)} seconds.`,
          code: "LOCKED",
          retryAfterMs: retryMs,
        },
        { status: 423 },
      );
    }

    // Activate PENDING_VERIFICATION accounts on first successful login.
    if (account.status === "PENDING_VERIFICATION") {
      await db.account.update({
        where: { id: account.id },
        data: {
          status: "ACTIVE",
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
        },
      });
      (account as { status: string }).status = "ACTIVE";
      await audit({
        actorId: account.id,
        action: "auth.account_activated",
        targetType: "Account",
        targetId: account.id,
        req,
      });
    }

    if (account.status === "SUSPENDED") {
      await supabase.auth.signOut();
      return NextResponse.json(
        {
          error:
            "Your account has been suspended. Please contact an administrator.",
          code: "SUSPENDED",
        },
        { status: 403 },
      );
    }

    // Anti-account-sharing: revoke previous refresh tokens (legacy field).
    await db.refreshToken
      .updateMany({
        where: { accountId: account.id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      .catch(() => {});

    await db.account.update({
      where: { id: account.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });

    await audit({
      actorId: account.id,
      action: "auth.login",
      targetType: "Account",
      targetId: account.id,
      req,
    });

    return NextResponse.json({
      id: account.id,
      email: account.email,
      fullName: account.fullName,
      role: account.role,
      status: account.status,
      studentId: account.studentId,
      program: account.program,
      section: account.section,
    });
  } catch (e) {
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    throw e;
  }
}
