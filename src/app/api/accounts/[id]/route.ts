import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { updateAccountSchema } from "@/lib/validation";
import {
  badRequest,
  forbidden,
  notFound,
  parseBody,
  requireAuth,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import { invalidateAccountCache } from "@/lib/supabase-session";
import {
  createSupabaseAdminClient,
  isSupabaseConfigured,
} from "@/lib/supabase-server";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/accounts/[id] (ADMIN)
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const res = await requireAuth("ADMIN");
  if ("error" in res) return res.error;
  const { account: admin } = res;
  const { id } = await params;

  const body = await parseBody(req);
  const parsed = updateAccountSchema.safeParse(body);
  if (!parsed.success)
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");

  const target = await db.account.findUnique({
    where: { id },
    select: { id: true, email: true, role: true },
  });
  if (!target) return notFound("Account not found");

  if (admin.id === id) {
    if (parsed.data.role && parsed.data.role !== admin.role) {
      return forbidden("You cannot change your own role");
    }
    if (parsed.data.status && parsed.data.status !== "ACTIVE") {
      return forbidden("You cannot suspend your own account");
    }
  }

  // ---- Last-admin guard: prevent demoting/suspending the last ADMIN ----
  if (
    target.role === "ADMIN" &&
    ((parsed.data.role && parsed.data.role !== "ADMIN") ||
      (parsed.data.status && parsed.data.status !== "ACTIVE"))
  ) {
    const adminCount = await db.account.count({
      where: { role: "ADMIN", status: "ACTIVE" },
    });
    if (adminCount <= 1) {
      return forbidden(
        "Cannot demote or suspend the last administrator account.",
      );
    }
  }

  // Check for email conflict if email is being changed
  if (parsed.data.email && parsed.data.email !== target.email) {
    const emailExists = await db.account.findUnique({
      where: { email: parsed.data.email },
      select: { id: true },
    });
    if (emailExists) {
      return badRequest("This email is already in use.", "EMAIL_TAKEN");
    }
  }

  const updated = await db.account.update({
    where: { id },
    data: {
      ...(parsed.data.role ? { role: parsed.data.role } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.fullName ? { fullName: parsed.data.fullName } : {}),
      ...(parsed.data.email ? { email: parsed.data.email } : {}),
      ...(parsed.data.program !== undefined
        ? { program: parsed.data.program }
        : {}),
      ...(parsed.data.section !== undefined
        ? { section: parsed.data.section }
        : {}),
      ...(parsed.data.year !== undefined ? { year: parsed.data.year } : {}),
      ...(parsed.data.organizationName !== undefined
        ? { organizationName: parsed.data.organizationName }
        : {}),
    },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      status: true,
      studentId: true,
      program: true,
      section: true,
      year: true,
      organizationName: true,
      lastLoginAt: true,
      createdAt: true,
      supabaseAuthUid: true,
    },
  });

  // If role or status changed, revoke all sessions for that account
  if (parsed.data.role || parsed.data.status) {
    await db.refreshToken.updateMany({
      where: { accountId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Invalidate the account cache so the change takes effect immediately.
    if (updated.supabaseAuthUid) {
      invalidateAccountCache(updated.supabaseAuthUid);
    }
  }

  // If email changed, sync to Supabase Auth so login uses the new email.
  // Without this, the DB and auth layer diverge (user must log in with the
  // OLD email, and re-registration with the new email fails).
  if (
    parsed.data.email &&
    parsed.data.email !== target.email &&
    updated.supabaseAuthUid &&
    isSupabaseConfigured()
  ) {
    try {
      const adminClient = createSupabaseAdminClient();
      const { error: emailUpdateError } =
        await adminClient.auth.admin.updateUserById(updated.supabaseAuthUid, {
          email: parsed.data.email,
        });
      if (emailUpdateError) {
        console.error(
          "[accounts.update] WARNING: failed to sync email to Supabase Auth:",
          emailUpdateError.message,
          "uid:",
          updated.supabaseAuthUid,
        );
        // Don't fail the whole request — the DB row is updated. The admin
        // can re-sync via the Supabase dashboard if needed.
      }
    } catch (e) {
      console.error(
        "[accounts.update] WARNING: Supabase admin client error syncing email:",
        e,
      );
    }
  }

  await audit({
    actorId: admin.id,
    action: "account.update",
    targetType: "Account",
    targetId: id,
    metadata: parsed.data,
    req,
  });

  return NextResponse.json(updated);
}
