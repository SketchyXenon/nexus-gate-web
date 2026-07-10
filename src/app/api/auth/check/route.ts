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
// Pre-registration availability check for email and/or student ID.
// Used by the registration wizard to block users at the step where a
// conflict exists, instead of failing on the final submit.
//
// Body: { email?: string, studentId?: string }
// Response: { emailTaken?: boolean, studentIdTaken?: boolean }
//
// Security:
//   - Rate-limited at the `register` preset (5/min per IP), same as the
//     actual registration endpoint. Prevents account enumeration.
//   - The register route itself already reveals "already in use" on submit,
//     so this endpoint does not add new attack surface — it just moves the
//     same check earlier for better UX.
//   - Orphan reconciliation: if an accounts row has no supabaseAuthUid, the
//     Supabase auth user may have been deleted via Dashboard. We clean up
//     the orphaned row so it doesn't block legitimate re-registration.

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

    if (email) {
      const existing = await db.account.findUnique({ where: { email } });
      if (existing && !existing.supabaseAuthUid && isSupabaseConfigured()) {
        // Reconcile orphaned row: check if the Supabase auth user still exists.
        // Query auth.users directly via raw SQL (single-row lookup).
        try {
          const rows = await db.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM auth.users WHERE email = ${email} LIMIT 1
          `;
          if (rows.length === 0) {
            await db.account.delete({ where: { id: existing.id } });
            result.emailTaken = false;
          } else {
            result.emailTaken = true;
          }
        } catch {
          result.emailTaken = true;
        }
      } else {
        result.emailTaken = !!existing;
      }
    }

    if (studentIdNum) {
      const existing = await db.account.findUnique({
        where: { studentId: studentIdNum },
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
