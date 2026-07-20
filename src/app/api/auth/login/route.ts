// Allow up to 15s for Supabase Auth round-trips (Hobby default is 10s).
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { loginSchema } from "@/lib/validation";
import {
  badRequest,
  checkRateLimitByEmail,
  checkRateLimitByKey,
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
import { invalidateAccountCache } from "@/lib/supabase-session";
import {
  safeFindAccountByEmail,
  safeFindAccountByAuthUid,
  isAccountDeactivated,
} from "@/lib/safe-account";

// Brute-force protection constants.
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// Pre-computed dummy bcrypt hash used to equalize response timing when the
// email is not found. Without this, the not-found path returns in ~1ms while
// the wrong-password path takes ~300ms (Supabase round-trip), creating a
// timing oracle that reveals which emails are registered. Comparing the
// supplied password against this fixed hash adds ~250ms to the not-found
// path, matching the wrong-password path closely enough to defeat the oracle.
const DUMMY_BCRYPT_HASH =
  "$2b$12$abcdefghijklmnopqrstuuKlQi5lSy3YoWcQv8m9E9X5JlqZ0Q1a2b3c4d5e6f7g8h9i0j";

// Single generic login-failure response. Per 06-security-architecture.md
// section 2, login must return an identical body + status for every
// non-success outcome (wrong password, non-existent email, unconfirmed,
// etc.) so an attacker cannot enumerate registered emails.
function loginFailed() {
  return unauthorized(
    "Incorrect email or password. Check your details and try again.",
  );
}

// POST /api/auth/login
// Signs in via Supabase Auth, then activates PENDING_VERIFICATION accounts.
// Rejects deactivated (soft-deleted) accounts.
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

    // Parse body FIRST so we can rate-limit by email (not IP).
    // Per-IP limiting blocks NAT'd campuses where 200+ students share one IP.
    const body = await parseBody(req);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const { email, password } = parsed.data;

    // Per-email rate limit (5/min). The DB lockout (5 fails -> 15-min) is
    // the primary brute-force defense; this prevents enumeration attempts.
    const rl = await checkRateLimitByEmail(email, "login");
    if (rl) return rl;

    // ---- Pre-auth lockout check ----
    // Uses safe lookup that degrades gracefully if migration 0017 not applied.
    const preCheck = await safeFindAccountByEmail(email, {
      failedLoginAttempts: true,
      lockedUntil: true,
    });

    // Lockout check. We KEEP the 423 LOCKED response here because by the time
    // an account is locked, the attacker has already made 5 failed attempts
    // against it (confirming it exists). The legitimate user needs the
    // retry-after info. Deactivated accounts are NOT rejected here (that would
    // be a pre-auth existence oracle); they fall through to signIn and are
    // handled post-auth below with the same generic 401 as every other failure.
    if (preCheck?.lockedUntil && preCheck.lockedUntil > new Date()) {
      const retryMs = preCheck.lockedUntil.getTime() - Date.now();
      return NextResponse.json(
        {
          error: `Too many failed attempts. Please try again in ${Math.ceil(retryMs / 1000)} seconds.`,
          code: "LOCKED",
          retryAfterMs: retryMs,
        },
        { status: 423, headers: { "Cache-Control": "no-store" } },
      );
    }

    // Per-account checkpoint (only for existing accounts — non-existent emails
    // are covered by the per-email limit above, so this doesn't leak existence).
    if (preCheck) {
      const acctRl = await checkRateLimitByKey(preCheck.id, "loginAccount");
      if (acctRl) return acctRl;
    }

    // Sign in via Supabase Auth (sets the session cookie).
    const supabase = await createSupabaseServerClient();
    const { data: authData, error: authError } =
      await supabase.auth.signInWithPassword({ email, password });

    if (authError || !authData.user) {
      // ---- Timing equalization for the not-found path ----
      // If the email isn't registered, preCheck is null and we skip the DB
      // increment. That makes the not-found path ~250ms faster than the
      // wrong-password path (which does a DB update). Running a dummy bcrypt
      // compare here adds comparable latency so the two paths are
      // indistinguishable by timing. The result is intentionally discarded.
      if (!preCheck) {
        await bcrypt.compare(password, DUMMY_BCRYPT_HASH).catch(() => {});
      }

      // ---- Atomic increment + compare-and-set lock ----
      // The increment is atomic. The lock-set is a SEPARATE conditional
      // update (where: { lockedUntil: null }) so two concurrent failures
      // can't both set the lock — the first wins, the second's condition
      // fails (0 rows). This closes the TOCTOU window where two concurrent
      // requests could both read count=4, both increment to 5, and both
      // skip the lock-set because neither had seen the other's increment.
      if (preCheck) {
        const updated = await db.account
          .update({
            where: { id: preCheck.id },
            data: { failedLoginAttempts: { increment: 1 } },
            select: { failedLoginAttempts: true },
          })
          .catch(() => null);
        if (updated && updated.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
          // Compare-and-set: only set lockedUntil if no concurrent request
          // has already set it. updateMany returns the count of affected rows;
          // 0 means another request won the race, which is fine (lock is set).
          await db.account
            .updateMany({
              where: { id: preCheck.id, lockedUntil: null },
              data: { lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) },
            })
            .catch(() => {});
        }
      }

      // Orphan-reconciliation: clean up silently if the auth user was deleted.
      if (preCheck?.supabaseAuthUid) {
        try {
          const admin = createSupabaseAdminClient();
          const { data: userData } = await admin.auth.admin.getUserById(
            preCheck.supabaseAuthUid,
          );
          if (!userData?.user) {
            console.log(
              `[login] cleaning orphaned accounts row for ${email} (auth user deleted)`,
            );
            await db.account.delete({ where: { id: preCheck.id } });
          }
        } catch {
          // Can't verify - fall through to the generic error.
        }
      }
      // ---- Single generic failure response ----
      // Every non-success path (wrong password, non-existent email, unconfirmed
      // email, deactivated) returns this identical response. Per
      // 06-security-architecture.md section 2, this prevents user enumeration.
      // The "email not confirmed" case is intentionally NOT surfaced as a
      // distinct response — it would reveal the email exists and is unconfirmed.
      return loginFailed();
    }
    const authUid = authData.user.id;

    // Load the linked accounts row (safe: degrades if migration 0017 missing).
    const account = await safeFindAccountByAuthUid(authUid);
    if (!account) {
      // No local row for this Supabase user. Sign out and return the generic
      // failure so the response is indistinguishable from a wrong password.
      await supabase.auth.signOut();
      return loginFailed();
    }

    // Reject deactivated accounts (defense-in-depth). Return the SAME generic
    // failure as a wrong password — a distinct 403 would reveal the account
    // exists and is deactivated (an enumeration oracle). The legitimate user
    // who is deactivated will see "incorrect email or password" and should
    // contact an administrator, who can explain the deactivation.
    if (isAccountDeactivated(account)) {
      await supabase.auth.signOut();
      return loginFailed();
    }

    // Activate PENDING_VERIFICATION accounts on first successful login.
    if (account.status === "PENDING_VERIFICATION") {
      // Safe update: sets emailVerifiedAt only if the column exists.
      try {
        await db.account.update({
          where: { id: account.id },
          data: {
            status: "ACTIVE",
            emailVerifiedAt: account.emailVerifiedAt ?? new Date(),
            failedLoginAttempts: 0,
            lockedUntil: null,
            lastLoginAt: new Date(),
          },
        });
      } catch (e) {
        // Migration 0017 not applied - update without the new column.
        await db.account.update({
          where: { id: account.id },
          data: {
            status: "ACTIVE",
            failedLoginAttempts: 0,
            lockedUntil: null,
            lastLoginAt: new Date(),
          },
        });
      }
      (account as { status: string }).status = "ACTIVE";
      invalidateAccountCache(authUid);
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
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }

    // Revoke previous refresh tokens (legacy field, defense-in-depth).
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

    return NextResponse.json(
      {
        id: account.id,
        email: account.email,
        fullName: account.fullName,
        role: account.role,
        status: account.status,
        studentId: account.studentId,
        program: account.program,
        section: account.section,
      },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } },
    );
  } catch (e) {
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    throw e;
  }
}
