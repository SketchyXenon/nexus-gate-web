import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { z } from "zod";
import {
  badRequest,
  checkRateLimit,
  dbUnavailable,
  isDbUnavailableError,
} from "@/lib/api";
import { isSupabaseConfigured } from "@/lib/supabase-server";

// POST /api/auth/check
// Pre-registration availability check for student ID only.
//
// ENUMERATION-SAFE DESIGN:
//   This endpoint NO LONGER checks email availability. Email enumeration
//   is now handled by the register route (returns the same success message
//   for new and existing emails, sending a sign-in link to existing users).
//
//   Student ID is still checked because:
//   1. Student IDs are not personal data (they're institutional identifiers)
//   2. The student already knows their own ID - no enumeration value
//   3. The UX benefit of catching a duplicate student ID early is significant
//
// Body: { studentId?: string }
// Response: { studentIdTaken?: boolean }

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
      return badRequest("Provide a studentId to check");
    }

    const result: { emailTaken?: boolean; studentIdTaken?: boolean } = {};

    // Email check: always return false. The register route handles existing
    // emails with an enumeration-safe "check your email" response. Returning
    // false here prevents the frontend from showing "email already in use".
    if (email) {
      result.emailTaken = false;
    }

    // Student ID check: still reveals taken/not-taken (no enumeration risk).
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
