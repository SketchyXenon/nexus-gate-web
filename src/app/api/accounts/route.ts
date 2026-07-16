mport { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { paginationSchema } from "@/lib/validation";
import { requireAuth, badRequest } from "@/lib/api";

// GET /api/accounts (ADMIN)
// Lists accounts. Deactivated (soft-deleted) accounts are hidden by default.
// Pass ?includeDeactivated=true to include them.
// Safe: degrades gracefully if migration 0017 not applied.
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
  const includeDeactivated = searchParams.get("includeDeactivated") === "true";
  const deactivatedOnly = searchParams.get("deactivatedOnly") === "true";

  const where: Record<string, unknown> = {};
  if (role && role !== "ALL") where.role = role;
  if (q) {
    where.OR = [
      { fullName: { contains: q } },
      { email: { contains: q } },
    ];
  }

  // Soft-delete filtering: only apply if migration 0017 applied.
  // We detect this by trying the query; if it fails with P2022, retry
  // without the isDeactivated filter.
  if (deactivatedOnly) {
    where.isDeactivated = true;
  } else if (!includeDeactivated) {
    where.isDeactivated = false;
  }

  const selectLegacy = {
    id: true, email: true, fullName: true, role: true, status: true,
    studentId: true, program: true, section: true, year: true,
    organizationName: true, lastLoginAt: true, createdAt: true,
  };
  const selectFull = {
    ...selectLegacy,
    isDeactivated: true, deactivatedAt: true,
  };

  try {
    const [accounts, total] = await Promise.all([
      db.account.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: selectFull,
      }),
      db.account.count({ where }),
    ]);
    return NextResponse.json({
      accounts,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    }, { headers: { "Cache-Control": "private, no-cache" } });
  } catch (e) {
    // P2022: column missing (migration 0017 not applied). Retry without
    // the new columns and the isDeactivated filter.
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2022") {
      const legacyWhere = { ...where };
      delete legacyWhere.isDeactivated;
      const [accounts, total] = await Promise.all([
        db.account.findMany({
          where: legacyWhere,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: selectLegacy,
        }),
        db.account.count({ where: legacyWhere }),
      ]);
      return NextResponse.json({
        accounts,
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      }, { headers: { "Cache-Control": "private, no-cache" } });
    }
    throw e;
  }
}