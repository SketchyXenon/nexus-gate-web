// ====================================================================
// Nexus Gate - Safe Account Lookup Helper
//
// Graceful degradation for the account deactivation / email verification
// migration (0017). If the production database hasn't had the migration
// applied yet (columns is_deactivated, email_verified_at, deactivated_at,
// deactivated_reason don't exist), these helpers retry the query WITHOUT
// the new columns instead of returning a 500.
//
// Once migration 0017 is applied, the full query runs and all features
// work normally. This is defense-in-depth so the app never crashes
// during a partial migration.
// ====================================================================

import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

// Fields that existed BEFORE migration 0017.
const LEGACY_FIELDS = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  status: true,
  studentId: true,
  program: true,
  section: true,
  organizationName: true,
  year: true,
  supabaseAuthUid: true,
  lastLoginAt: true,
  failedLoginAttempts: true,
  lockedUntil: true,
} as const;

// Fields added by migration 0017.
const NEW_FIELDS = {
  isDeactivated: true,
  emailVerifiedAt: true,
  deactivatedAt: true,
  deactivatedReason: true,
} as const;

// Detect Prisma P2022 error (column not found).
function isMissingColumnError(e: unknown): boolean {
  if (typeof e === "object" && e !== null && "code" in e) {
    return (e as { code: string }).code === "P2022";
  }
  return false;
}

// Shape of the returned account (new fields are optional for legacy rows).
export type SafeAccount = {
  id: string;
  email: string;
  fullName: string;
  role: string;
  status: string;
  studentId: number | null;
  program: string | null;
  section: string | null;
  organizationName: string | null;
  year: number | null;
  supabaseAuthUid: string | null;
  lastLoginAt: Date | null;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  isDeactivated?: boolean;
  emailVerifiedAt?: Date | null;
  deactivatedAt?: Date | null;
  deactivatedReason?: string | null;
};

// Safe findUnique by email. Returns null if not found.
// Falls back to legacy columns if migration 0017 not applied.
export async function safeFindAccountByEmail(
  email: string,
  extraSelect: Prisma.AccountSelect = {},
): Promise<SafeAccount | null> {
  const fullSelect = { ...LEGACY_FIELDS, ...NEW_FIELDS, ...extraSelect };
  try {
    return (await db.account.findUnique({
      where: { email },
      select: fullSelect,
    })) as SafeAccount | null;
  } catch (e) {
    if (isMissingColumnError(e)) {
      // Migration 0017 not applied - retry without new columns.
      return (await db.account.findUnique({
        where: { email },
        select: { ...LEGACY_FIELDS, ...extraSelect },
      })) as SafeAccount | null;
    }
    throw e;
  }
}

// Safe findUnique by id. Returns null if not found.
export async function safeFindAccountById(
  id: string,
  extraSelect: Prisma.AccountSelect = {},
): Promise<SafeAccount | null> {
  const fullSelect = { ...LEGACY_FIELDS, ...NEW_FIELDS, ...extraSelect };
  try {
    return (await db.account.findUnique({
      where: { id },
      select: fullSelect,
    })) as SafeAccount | null;
  } catch (e) {
    if (isMissingColumnError(e)) {
      return (await db.account.findUnique({
        where: { id },
        select: { ...LEGACY_FIELDS, ...extraSelect },
      })) as SafeAccount | null;
    }
    throw e;
  }
}

// Safe findFirst by supabaseAuthUid. Returns null if not found.
export async function safeFindAccountByAuthUid(
  authUid: string,
): Promise<SafeAccount | null> {
  const fullSelect = { ...LEGACY_FIELDS, ...NEW_FIELDS };
  try {
    return (await db.account.findFirst({
      where: { supabaseAuthUid: authUid },
      select: fullSelect,
    })) as SafeAccount | null;
  } catch (e) {
    if (isMissingColumnError(e)) {
      return (await db.account.findFirst({
        where: { supabaseAuthUid: authUid },
        select: { ...LEGACY_FIELDS },
      })) as SafeAccount | null;
    }
    throw e;
  }
}

// Check if an account is deactivated. Returns false if the field is
// missing (migration not applied) - fail open so login works.
export function isAccountDeactivated(account: SafeAccount | null): boolean {
  return Boolean(account?.isDeactivated);
}

// Safe update: sets deactivation fields. Falls back to status-only update
// if the columns don't exist.
export async function safeDeactivateAccount(
  accountId: string,
  reason?: string,
): Promise<void> {
  try {
    await db.account.update({
      where: { id: accountId },
      data: {
        isDeactivated: true,
        deactivatedAt: new Date(),
        deactivatedReason: reason || null,
        status: "DEACTIVATED",
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
  } catch (e) {
    if (isMissingColumnError(e)) {
      // Migration not applied - just set status (best effort).
      await db.account.update({
        where: { id: accountId },
        data: {
          status: "DEACTIVATED",
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
    } else {
      throw e;
    }
  }
}

// Safe update: restores a deactivated account.
export async function safeRestoreAccount(
  accountId: string,
  emailVerified: boolean,
): Promise<void> {
  const restoredStatus = emailVerified ? "ACTIVE" : "PENDING_VERIFICATION";
  try {
    await db.account.update({
      where: { id: accountId },
      data: {
        isDeactivated: false,
        deactivatedAt: null,
        deactivatedReason: null,
        status: restoredStatus,
      },
    });
  } catch (e) {
    if (isMissingColumnError(e)) {
      await db.account.update({
        where: { id: accountId },
        data: { status: restoredStatus },
      });
    } else {
      throw e;
    }
  }
}
