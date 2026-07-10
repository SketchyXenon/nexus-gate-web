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
  dbUnavailable,
  isDbUnavailableError,
} from "@/lib/api";
import { audit } from "@/lib/audit";
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

    const body = await parseBody(req);
    const parsed = adminCreateAccountSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const d = parsed.data;

    // Reconciliation: if the accounts row exists but has no supabaseAuthUid
    // (orphaned from a Supabase Dashboard deletion), clean it up first.
    const existing = await db.account.findUnique({ where: { email: d.email } });
    if (existing && !existing.supabaseAuthUid && isSupabaseConfigured()) {
      try {
        // Query auth.users directly via raw SQL (single-row lookup).
        const rows = await db.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM auth.users WHERE email = ${d.email} LIMIT 1
        `;
        if (rows.length === 0) {
          console.log(
            `[accounts/create] cleaning orphaned accounts row for ${d.email}`,
          );
          await db.account.delete({ where: { id: existing.id } });
        } else {
          return conflict(
            "An account with this email already exists.",
            "EMAIL_TAKEN",
          );
        }
      } catch {
        // Can't verify - block the creation to be safe.
        return conflict(
          "An account with this email already exists.",
          "EMAIL_TAKEN",
        );
      }
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
      return badRequest(
        "Unable to create auth user. " + (authError?.message ?? ""),
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
