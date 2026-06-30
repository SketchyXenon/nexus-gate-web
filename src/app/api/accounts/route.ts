import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { paginationSchema } from "@/lib/validation";
import { requireAuth, badRequest } from "@/lib/api";

// GET /api/accounts (ADMIN)
export async function GET(req: NextRequest) {
  const res = await requireAuth("ADMIN");
  if ("error" in res) return res.error;

  const { searchParams } = new URL(req.url);
  const parsed = paginationSchema.safeParse({
    page: searchParams.get("page") ?? 1,
    pageSize: searchParams.get("pageSize") ?? 50,
  });
  if (!parsed.success) return badRequest("Invalid pagination parameters");
  const { page, pageSize } = parsed.data;
  const role = searchParams.get("role") || undefined;
  const q = searchParams.get("q") || undefined;

  const where: Record<string, unknown> = {};
  if (role && role !== "ALL") where.role = role;
  if (q) {
    where.OR = [
      { fullName: { contains: q } },
      { email: { contains: q } },
    ];
  }

  const [accounts, total] = await Promise.all([
    db.account.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, email: true, fullName: true, role: true, status: true,
        studentId: true, program: true, section: true, year: true,
        organizationName: true, lastLoginAt: true, createdAt: true,
      },
    }),
    db.account.count({ where }),
  ]);

  return NextResponse.json({
    accounts,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
}
