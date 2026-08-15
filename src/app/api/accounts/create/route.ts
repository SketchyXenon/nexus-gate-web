// Allow up to 15s for Supabase Auth round-trips (Hobby default is 10s).
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { adminCreateAccountSchema } from "@/lib/validation";
import {
  badRequest,
  conflict,
  parseBody,
  requireAuth,
  checkRateLimitByKey,
  dbUnavailable,
  isDbUnavailableError,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  DEFAULT_NOTIFICATION_PREFS,
  serializeNotificationPrefs,
} from "@/lib/notification-prefs";
import {
  createSupabaseAdminClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";

// POST /api/accounts/create (ADMIN only)
// Creates a Supabase Auth user + linked accounts row (ADMIN/ORGANIZER).
export async function POST(req: NextRequest) {
  try {
    const res = await requireAuth("ADMIN");
    if ("error" in res) return res.error;
    const { account: admin } = res;

    // Tighter rate limit for admin destructive mutations (20/min vs the
    // default 100/min apiAccount). Account creation hits Supabase Auth +
    // the DB, so an attacker (or a runaway admin script) could otherwise
    // create 100 accounts/min. This preset fails CLOSED on limiter error.
    const adminRl = await checkRateLimitByKey(admin.id, "adminMutation");
    if (adminRl) return adminRl;

    const body = await parseBody(req);
    const parsed = adminCreateAccountSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const d = parsed.data;

    // Reconciliation: if an accounts row exists but has no supabaseAuthUid
    // (orphaned from a Supabase Dashboard deletion), delete the orphan so
    // the create flow can proceed cleanly. The createUser call below is the
    // authoritative check for whether a Supabase auth user exists - if one
    // does, it returns "already registered" and we block. This removes the
    // old raw-SQL join against auth.users (which is Supabase-internal and
    // unreachable when the app tables move to TiDB).
    const existing = await db.account.findUnique({
      where: { email: d.email },
      select: { id: true, supabaseAuthUid: true },
    });
    if (existing && !existing.supabaseAuthUid) {
      await db.account.delete({ where: { id: existing.id } }).catch(() => {});
    } else if (existing) {
      return conflict(
        "An account with this email already exists.",
        "EMAIL_TAKEN",
      );
    }

    // Create the Supabase Auth user (admin API bypasses email confirmation).
    const supabase = createSupabaseAdminClient();
    const { data: authData, error: authError } =
      await supabase.auth.admin.createUser({
        email: d.email,
        password: d.password,
        email_confirm: true,
        user_metadata: { fullName: d.fullName },
      });
    if (authError || !authData.user) {
      console.error(
        "[accounts/create] Supabase createUser failed:",
        authError?.message ?? "no error",
      );
      // This is an admin-only route, so a clear "already exists" message is
      // safe (no enumeration risk - the admin already knows the email).
      // This is also the authoritative existence check now that the raw
      // auth.users query is gone (TiDB-compatible).
      const msg = (authError?.message ?? "").toLowerCase();
      if (
        msg.includes("already registered") ||
        msg.includes("user already") ||
        msg.includes("already been registered")
      ) {
        return conflict(
          "An account with this email already exists.",
          "EMAIL_TAKEN",
        );
      }
      return badRequest(
        "Unable to create the account. Please try again or contact support.",
        "AUTH_FAILED",
      );
    }

    let account;
    try {
      account = await db.account.create({
        data: {
          email: d.email,
          passwordHash: "",
          fullName: d.fullName,
          role: d.role,
          status: d.status,
          program: d.program ?? null,
          section: d.section ?? null,
          organizationName: d.organizationName ?? null,
          supabaseAuthUid: authData.user.id,
          lastLoginAt: new Date(),
          // Seed default notification prefs (TiDB has no column-level default).
          notificationPrefs: serializeNotificationPrefs(
            DEFAULT_NOTIFICATION_PREFS,
          ) as never,
        },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          status: true,
          program: true,
          section: true,
          organizationName: true,
          createdAt: true,
        },
      });
    } catch (e) {
      // Roll back the Supabase user if the accounts row fails.
      await supabase.auth.admin.deleteUser(authData.user.id).catch(() => {});
      throw e;
    }

    await audit({
      actorId: admin.id,
      action: "account.create",
      targetType: "Account",
      targetId: account.id,
      metadata: { email: d.email, role: d.role },
      req,
    });

    return NextResponse.json(account, { status: 201 });
  } catch (e) {
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    throw e;
  }
}
