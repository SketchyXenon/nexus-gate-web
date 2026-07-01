import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { updateProfileSchema } from "@/lib/validation";
import { badRequest, forbidden, parseBody, requireAuth } from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  isYearSectionConsistent,
  YEAR_SECTION_MISMATCH_MESSAGE,
} from "@/lib/section-validation";
import { isCooldownExpired, daysUntilCooldownExpires } from "@/lib/cooldown";

// ====================================================================
// GET /api/profile — returns the current user's full profile
// Admins are excluded from profile editing (they manage via Accounts).
// Exposes cooldown flags for both profile updates and password changes.
// ====================================================================
export async function GET(_req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  const profile = await db.account.findUnique({
    where: { id: account.id },
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
      courseModifiedAt: true,
      lastProfileUpdateAt: true,
      lastPasswordChangeAt: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });

  if (!profile) return badRequest("Account not found");

  // ---- Profile update cooldown (30 days) ----
  const canUpdate = isCooldownExpired(profile.lastProfileUpdateAt);
  const daysUntilUpdate = daysUntilCooldownExpires(profile.lastProfileUpdateAt);

  // Course can only be changed once (courseModifiedAt is null = never changed)
  const canChangeCourse = profile.role === "USER" && !profile.courseModifiedAt;

  // ---- Password change cooldown (30 days) ----
  const canChangePassword = isCooldownExpired(profile.lastPasswordChangeAt);
  const daysUntilPasswordChange = daysUntilCooldownExpires(profile.lastPasswordChangeAt);

  return NextResponse.json({
    ...profile,
    canUpdateProfile: canUpdate,
    daysUntilProfileUpdate: Math.max(0, daysUntilUpdate),
    canChangeCourse,
    canChangePassword,
    daysUntilPasswordChange: Math.max(0, daysUntilPasswordChange),
  });
}

// ====================================================================
// PATCH /api/profile — update own profile
// Admins: EXCLUDED (they use the admin accounts page)
// Organizers: can change fullName only
// Users: can change fullName, year, section, and course (course once only)
// 30-day cooldown applies to all profile updates.
//
// SERVER-SIDE VALIDATIONS (cannot be bypassed by the client):
//   1. 30-day cooldown since last profile update
//   2. "No changes" detection — rejects submissions where NO field changed
//   3. Year/section consistency — section's numeric prefix must match year
//      (e.g. Year 3 → "3-A", not "2-B")
//   4. Course can only be changed once (courseModifiedAt gate)
//   5. Program must be a valid code from PROGRAM_CODES (Zod schema)
// ====================================================================
export async function PATCH(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  // Admins cannot edit their own profile via this endpoint
  if (account.role === "ADMIN") {
    return forbidden("Administrators manage their accounts through the admin panel.");
  }

  // ---- Fetch the FULL current record for accurate change detection ----
  // CRITICAL: We must select ALL comparable fields (fullName, program,
  // section, year) — not just a subset. Previously this query only
  // selected `program`, which meant `fullName !== current?.fullName`
  // was always `string !== undefined` → always true → the "no changes"
  // check NEVER fired. Now we select everything needed.
  const current = await db.account.findUnique({
    where: { id: account.id },
    select: {
      lastProfileUpdateAt: true,
      courseModifiedAt: true,
      program: true,
      fullName: true,
      section: true,
      year: true,
    },
  });

  if (!current) return badRequest("Account not found");

  const body = await parseBody(req);
  const parsed = updateProfileSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const { fullName, program, year, section } = parsed.data;

  // ---- SERVER-SIDE VALIDATION: Year/section consistency ----
  // This runs BEFORE the cooldown check so invalid input is always rejected,
  // even during the cooldown period. The section's numeric prefix MUST
  // match the year (e.g. Year 3 → "3-A", not "2-B").
  //   Year 3 + section "3-A" → OK
  //   Year 3 + section "2-B" → REJECT (prefix "2" ≠ year 3)
  //   Year 3 + section "A"   → OK (no numeric prefix, can't validate)
  if (account.role === "USER") {
    const effectiveYear = year !== undefined ? year : current.year;
    const effectiveSection = section !== undefined ? section : current.section;
    if (effectiveYear !== null && effectiveSection && effectiveSection.trim()) {
      if (!isYearSectionConsistent(effectiveYear, effectiveSection)) {
        return badRequest(
          YEAR_SECTION_MISMATCH_MESSAGE(effectiveYear, effectiveSection),
          "YEAR_SECTION_MISMATCH"
        );
      }
    }
  }

  // ---- SERVER-SIDE VALIDATION: "No changes" detection ----
  // Compare EVERY submitted field against its current value. If NOTHING
  // changed, reject with a clear message. This runs BEFORE the cooldown
  // check so that no-op submissions are always rejected — they should NOT
  // be blocked by the cooldown message (which would be confusing) and
  // should NOT consume the cooldown.
  const changes: string[] = [];
  if (fullName !== current.fullName) changes.push("name");
  if (account.role === "USER") {
    // Normalize undefined → current value for comparison. The frontend
    // only sends fields that changed, so `program`/`year`/`section` may
    // be undefined here. We compare the effective value (submitted or
    // current) against the current value.
    const effectiveProgram = program !== undefined ? (program || null) : current.program;
    const effectiveSection = section !== undefined ? section : current.section;
    const effectiveYear = year !== undefined ? year : current.year;
    if (effectiveProgram !== current.program) changes.push("program");
    if (effectiveSection !== current.section) changes.push("section");
    if (effectiveYear !== current.year) changes.push("year");
  }
  if (account.role === "ORGANIZER") {
    // Organizers can ONLY change fullName. Program/section/year are
    // admin-managed. Do NOT compare program/section for organizers —
    // doing so would burn their 30-day cooldown without persisting
    // any change (the updateData below only saves fullName).
  }

  if (changes.length === 0) {
    return badRequest(
      "No changes detected. Modify at least one field before saving.",
      "NO_CHANGES"
    );
  }

  // ---- Check 30-day profile update cooldown ----
  // Only enforced when there ARE actual changes to make. No-op submissions
  // are already rejected above, so reaching this point means the user is
  // trying to make a real change.
  if (!isCooldownExpired(current.lastProfileUpdateAt)) {
    const daysLeft = daysUntilCooldownExpires(current.lastProfileUpdateAt);
    return forbidden(
      `You can update your profile again in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`
    );
  }

  // Build update data based on role
  const updateData: Record<string, unknown> = {
    fullName,
    lastProfileUpdateAt: new Date(),
  };

  if (account.role === "USER") {
    // Students can update year and section freely
    if (year !== undefined) updateData.year = year;
    if (section !== undefined) updateData.section = section;

    // Course (program) can only be changed once
    const effectiveProgram = program !== undefined ? (program || null) : current.program;
    if (effectiveProgram !== current.program) {
      if (current.courseModifiedAt) {
        return forbidden(
          "You can only change your course once. Please contact an administrator if you need to change it again."
        );
      }
      if (effectiveProgram !== null) {
        updateData.program = effectiveProgram;
        updateData.courseModifiedAt = new Date();
      }
    }
  }
  // Organizers: only fullName is saved (other fields ignored)

  const updated = await db.account.update({
    where: { id: account.id },
    data: updateData,
    select: {
      id: true, fullName: true, role: true, program: true, section: true,
      year: true, courseModifiedAt: true, lastProfileUpdateAt: true,
    },
  });

  await audit({
    actorId: account.id, action: "profile.update", targetType: "Account",
    targetId: account.id, metadata: { fullName, role: account.role, changes }, req,
  });

  return NextResponse.json({
    ...updated,
    canUpdateProfile: false,
    daysUntilProfileUpdate: 30,
    canChangeCourse: account.role === "USER" && !updated.courseModifiedAt,
  });
}
