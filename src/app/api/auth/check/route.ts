import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { z } from "zod";
import {
  badRequest,
  checkRateLimit,
  dbUnavailable,
  isDbUnavailableError,
} from "@/lib/api";

// POST /api/auth/check
// Pre-registration availability check for email AND student ID.
//
// Reports whether an email or student ID is already registered so the
// frontend can warn the user BEFORE submit. The register route also
// enforces this server-side (defense-in-depth) and returns a 409 for
// duplicates, so a client-side bypass cannot create a duplicate account.
//
// Student IDs are institutional identifiers the student already knows, so
// reporting taken/not-taken carries no enumeration risk. Emails are checked
// against NON-deactivated accounts only — a deactivated email is eligible
// for re-registration, so it must report as available.

const checkSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255).optional(),
  studentId: z
    .union([
      z.number().int().min(1000000).max(9999999),
      z.string().regex(/^\d{7}$/),
    ])
    .optional(),
});

export async function POST(req: NextRequest) {
  try {
    const rl = await checkRateLimit(req, "check");
    if (rl) return rl;

    const body = await req.json().catch(() => ({}));
    const parsed = checkSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const { email, studentId } = parsed.data;
    const studentIdNum =
      typeof studentId === "string" ? Number(studentId) : studentId;

    if (!email && !studentIdNum) {
      return badRequest("Provide an email or studentId to check");
    }

    const result: { emailTaken?: boolean; studentIdTaken?: boolean } = {};

    // Email check: report taken only for NON-deactivated accounts.
    // Deactivated accounts are eligible for re-registration, so they report
    // as available. This matches the register route's re-registration path.
    if (email) {
      const existing = await db.account.findUnique({
        where: { email },
        select: { id: true, isDeactivated: true },
      });
      result.emailTaken = !!existing && !existing.isDeactivated;
    }

    // Student ID check: reveals taken/not-taken (no enumeration risk).
    if (studentIdNum) {
      const existing = await db.account.findUnique({
        where: { studentId: studentIdNum },
        select: { id: true },
      });
      result.studentIdTaken = !!existing;
    }

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    throw e;
  }
}
