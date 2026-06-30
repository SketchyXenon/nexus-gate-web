import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { adminCreateAccountSchema } from "@/lib/validation";
import {
  badRequest, conflict, parseBody, requireAuth,
} from "@/lib/api";
import { audit } from "@/lib/audit";

// ====================================================================
// POST /api/accounts/create (ADMIN only)
// Creates a new ADMIN or ORGANIZER account (no student ID needed).
// Account is created as ACTIVE (no email verification needed since
// the admin is creating it directly).
// ====================================================================
export async function POST(req: NextRequest) {
  const res = await requireAuth("ADMIN");
  if ("error" in res) return res.error;
  const { account: admin } = res;

  const body = await parseBody(req);
  const parsed = adminCreateAccountSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const d = parsed.data;

  // Check for existing email
  const existing = await db.account.findUnique({ where: { email: d.email } });
  if (existing) {
    return conflict("An account with this email already exists.", "EMAIL_TAKEN");
  }

  const passwordHash = await hashPassword(d.password);
  const account = await db.account.create({
    data: {
      email: d.email,
      passwordHash,
      fullName: d.fullName,
      role: d.role,
      status: d.status,
      program: d.program ?? null,
      section: d.section ?? null,
      organizationName: d.organizationName ?? null,
      lastLoginAt: new Date(),
    },
    select: {
      id: true, email: true, fullName: true, role: true, status: true,
      program: true, section: true, organizationName: true, createdAt: true,
    },
  });

  await audit({
    actorId: admin.id, action: "account.create", targetType: "Account",
    targetId: account.id, metadata: { email: d.email, role: d.role }, req,
  });

  return NextResponse.json(account, { status: 201 });
}
