import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, badRequest } from "@/lib/api";
import { paginationSchema } from "@/lib/validation";

// GET /api/audit-logs (ADMIN)
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
  const action = searchParams.get("action") || undefined;
  const where: Record<string, unknown> = {};
  if (action) where.action = { contains: action };

  const [logs, total] = await Promise.all([
    db.auditLog.findMany({
      where, orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize, take: pageSize,
      include: { actor: { select: { fullName: true, email: true } } },
    }),
    db.auditLog.count({ where }),
  ]);

  return NextResponse.json({
    logs,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
}
