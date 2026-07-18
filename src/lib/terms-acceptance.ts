// ====================================================================
// Nexus Gate - Terms Acceptance Recorder
//
// Writes an immutable, append-only record to the terms_acceptances
// table every time a user accepts the Terms and Privacy Policy.
// Gracefully degrades if the table doesn't exist (migration 0018
// not applied yet) - the registration still succeeds, the audit
// log still records the acceptance.
// ====================================================================

import "server-only";
import { db } from "@/lib/db";
import type { NextRequest } from "next/server";
import { getClientIp } from "@/lib/api";

// Current document versions. Bump these when the Terms or Policy change.
// The hash should be the SHA-256 of the document content at that version.
export const CURRENT_TERMS_VERSION = "1.0.0";
export const CURRENT_TERMS_HASH = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
export const CURRENT_POLICY_VERSION = "1.0.0";
export const CURRENT_POLICY_HASH = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

export interface TermsAcceptanceRecord {
  accountId: string;
  termsVersion: string;
  termsHash: string;
  policyVersion: string;
  policyHash: string;
  ipAddress?: string;
  userAgent?: string;
}

// Record a terms acceptance. Append-only (never updates or deletes).
// Returns true on success, false if the table is missing (graceful degradation).
export async function recordTermsAcceptance(
  accountId: string,
  req?: NextRequest,
): Promise<boolean> {
  try {
    const ipAddress = req ? getClientIp(req) : null;
    const userAgent = req?.headers.get("user-agent") ?? null;

    await db.termsAcceptance.create({
      data: {
        accountId,
        termsVersion: CURRENT_TERMS_VERSION,
        termsHash: CURRENT_TERMS_HASH,
        policyVersion: CURRENT_POLICY_VERSION,
        policyHash: CURRENT_POLICY_HASH,
        ipAddress,
        userAgent,
      },
    });
    return true;
  } catch (e) {
    // P2021: table doesn't exist (migration 0018 not applied).
    // P2022: column doesn't exist. Both are graceful degradation cases.
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      ((e as { code: string }).code === "P2021" ||
        (e as { code: string }).code === "P2022")
    ) {
      console.warn(
        "[terms-acceptance] table not found - migration 0018 not applied. Acceptance recorded in audit log only.",
      );
      return false;
    }
    // Non-critical: don't fail the registration if the terms record fails.
    console.error("[terms-acceptance] failed to record:", e);
    return false;
  }
}

// Get all terms acceptances for an account (compliance audit).
export async function getTermsAcceptances(accountId: string) {
  try {
    return await db.termsAcceptance.findMany({
      where: { accountId },
      orderBy: { acceptedAt: "desc" },
    });
  } catch {
    // Table missing - return empty array.
    return [];
  }
}
