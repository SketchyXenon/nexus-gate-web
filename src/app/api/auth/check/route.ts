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
// Pre-registration availability check for student ID only.
//
// SECURITY: email availability is intentionally NOT exposed on this
// anonymous endpoint. Reporting whether an arbitrary email is registered
// is an enumeration oracle (an attacker rotating IPs could probe the entire
// student body's email list), which defeats the enumeration-safe design of
// /api/auth/login, /register, /forgot-password, and /magic-link. Email
// uniqueness is enforced server-side by the register route (returns 409 on
// duplicate), so users still get clear feedback on submit.
//
// Student IDs are institutional identifiers the student already knows, so
// reporting taken/not-taken carries no enumeration risk.

const checkSchema = z.object({
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
    const { studentId } = parsed.data;
    const studentIdNum =
      typeof studentId === "string" ? Number(studentId) : studentId;

    if (!studentIdNum) {
      return badRequest("Provide a studentId to check");
    }

    const result: { studentIdTaken?: boolean } = {};

    // Student ID check: reveals taken/not-taken (no enumeration risk).
    const existing = await db.account.findUnique({
      where: { studentId: studentIdNum },
      select: { id: true },
    });
    result.studentIdTaken = !!existing;

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    throw e;
  }
}
