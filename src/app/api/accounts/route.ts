import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { paginationSchema } from "@/lib/validation";
import { requireAuth, badRequest } from "@/lib/api";
import { visibleEventWhereOr } from "@/lib/event-visibility";

// Per-account attendance stats (USER accounts only): attended check-ins
// vs. eligible events that have already started (scheduledAt <= now,
// not cancelled) under the v8 visibility rule. rate is null when the
// student has no eligible events yet (no denominator) - UI shows a dash.
interface AccountAttendanceStats {
  attended: number;
  eligible: number;
  rate: number | null;
}

async function attachAttendanceStats<
  T extends {
    id: string;
    role: string;
    program: string | null;
    section: string | null;
  },
>(
  accounts: T[],
): Promise<(T & { attendance: AccountAttendanceStats | null })[]> {
  const students = accounts.filter((a) => a.role === "USER");
  if (students.length === 0) {
    return accounts.map((a) => ({ ...a, attendance: null }));
  }

  const attendedByAccount = new Map<string, number>();
  const grouped = await db.eventAttendance.groupBy({
    by: ["accountId"],
    _count: { _all: true },
    where: { accountId: { in: students.map((a) => a.id) } },
  });
  for (const g of grouped) attendedByAccount.set(g.accountId, g._count._all);

  // One eligible-event count per unique (program, section) combo.
  const combos = new Map<
    string,
    { program: string | null; section: string | null }
  >();
  for (const a of students) {
    const key = `${a.program ?? ""}|${a.section ?? ""}`;
    if (!combos.has(key)) {
      combos.set(key, {
        program: a.program ?? null,
        section: a.section ?? null,
      });
    }
  }
  const eligibleByCombo = new Map<string, number>();
  await Promise.all(
    [...combos.entries()].map(async ([key, c]) => {
      const count = await db.event.count({
        where: {
          scheduledAt: { lte: new Date() },
          status: { not: "cancelled" },
          OR: visibleEventWhereOr(c.program, c.section),
        },
      });
      eligibleByCombo.set(key, count);
    }),
  );

  return accounts.map((a) => {
    if (a.role !== "USER") return { ...a, attendance: null };
    const attended = attendedByAccount.get(a.id) ?? 0;
    const eligible =
      eligibleByCombo.get(`${a.program ?? ""}|${a.section ?? ""}`) ?? 0;
    const rate =
      eligible > 0
        ? Math.min(100, Math.round((attended / eligible) * 100))
        : null;
    return { ...a, attendance: { attended, eligible, rate } };
  });
}

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
    where.OR = [{ fullName: { contains: q } }, { email: { contains: q } }];
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
    id: true,
    email: true,
    fullName: true,
    role: true,
    status: true,
    studentId: true,
    program: true,
    section: true,
    year: true,
    organizationName: true,
    lastLoginAt: true,
    createdAt: true,
  };
  const selectFull = {
    ...selectLegacy,
    isDeactivated: true,
    deactivatedAt: true,
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
    const enriched = await attachAttendanceStats(accounts);
    return NextResponse.json(
      {
        accounts: enriched,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },
      },
      { headers: { "Cache-Control": "private, no-cache" } },
    );
  } catch (e) {
    // P2022: column missing (migration 0017 not applied). Retry without
    // the new columns and the isDeactivated filter.
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code: string }).code === "P2022"
    ) {
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
      const enriched = await attachAttendanceStats(accounts);
      return NextResponse.json(
        {
          accounts: enriched,
          pagination: {
            page,
            pageSize,
            total,
            totalPages: Math.ceil(total / pageSize),
          },
        },
        { headers: { "Cache-Control": "private, no-cache" } },
      );
    }
    throw e;
  }
}
