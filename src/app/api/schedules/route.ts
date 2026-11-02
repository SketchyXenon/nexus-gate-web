import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  schedulePaginationSchema,
  createScheduleSchema,
} from "@/lib/validation";
import {
  badRequest,
  conflict,
  forbidden,
  parseBody,
  requireAuth,
  checkRateLimitByKey,
  isDbUnavailableError,
  dbUnavailable,
  dbSchemaDrift,
} from "@/lib/api";
import {
  isUniqueConstraintError,
  isSchemaDriftError,
} from "@/lib/prisma-errors";
import { audit } from "@/lib/audit";

// ====================================================================
// Schedules (recurring weekly class timetable, day & night shifts)
// --------------------------------------------------------------------
// Students (USER) get a READ-ONLY view scoped to their own program,
// section, and shift. Organizers manage their own program's timetable;
// admins manage everything (mirrors the events/whitelist ABAC model).
// ====================================================================

// GET /api/schedules (any authenticated role)
//  - USER: only active rows matching their program+section (plus
//    department-wide rows), shift filter honored.
//  - ORGANIZER: forced to their own program (section rows + program-wide
//    rows). Department-wide rows are admin-managed.
//  - ADMIN: everything.
export async function GET(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;
  const isOrganizer = account.role === "ORGANIZER";

  const { searchParams } = new URL(req.url);
  const parsed = schedulePaginationSchema.safeParse({
    page: searchParams.get("page") ?? 1,
    pageSize: searchParams.get("pageSize") ?? 100,
    shift: searchParams.get("shift") ?? "ALL",
    day: searchParams.get("day") ?? undefined,
    q: searchParams.get("q") ?? undefined,
  });
  if (!parsed.success) return badRequest("Invalid schedule filters");
  const { page, pageSize, shift, day, q } = parsed.data;

  const where: Record<string, unknown> = {};

  if (account.role === "USER") {
    // Students: strict scoping (mirrors event visibility). A student with
    // no program/section on their profile sees only department-wide rows.
    // NOTE: the q filter below overwrites this OR - students cannot search,
    // they get the shift/day-filtered timetable for their own section.
    where.isActive = true;
    where.OR = [
      { program: account.program ?? null, section: account.section ?? null },
      { program: account.program ?? null, section: null },
      { program: null, section: null },
    ];
    // Students with a known shift default to their own shift unless the
    // client explicitly asks for the other one (both shifts stay visible).
  } else if (isOrganizer) {
    // ABAC / POLP: organizers manage only their own program. A sentinel
    // program (matches no rows) when unset - never the whole timetable.
    where.program = account.program ?? "__none__";
  }

  if (shift !== "ALL") where.shift = shift;
  if (day !== undefined) where.dayOfWeek = day;
  if (q && account.role !== "USER") {
    where.OR = [
      { subject: { contains: q } },
      { instructor: { contains: q } },
      { section: { contains: q } },
      { room: { contains: q } },
    ];
  }

  try {
    const [schedules, total] = await Promise.all([
      db.schedule.findMany({
        where,
        orderBy: [
          { shift: "asc" },
          { dayOfWeek: "asc" },
          { startTime: "asc" },
          { section: "asc" },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          ownerId: true,
          program: true,
          section: true,
          shift: true,
          dayOfWeek: true,
          subject: true,
          instructor: true,
          room: true,
          startTime: true,
          endTime: true,
          isActive: true,
        },
      }),
      db.schedule.count({ where }),
    ]);

    return NextResponse.json(
      {
        schedules,
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
    if (isSchemaDriftError(e)) return dbSchemaDrift(e);
    return dbUnavailable(e);
  }
}

// POST /api/schedules (ORGANIZER+)
// Creates one weekly class slot. Exact duplicates (same section, shift,
// day, start time, subject) are rejected idempotently via the
// schedules_slot_key unique constraint.
export async function POST(req: NextRequest) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;

  // Admin-mutation preset (20/min): schedule edits are bulk-adjacent
  // operations and must not be spam-able.
  const rl = await checkRateLimitByKey(account.id, "adminMutation");
  if (rl) return rl;

  const body = await parseBody(req);
  const parsed = createScheduleSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const data = parsed.data;

  // ABAC / POLP: organizers always own what they create and are locked to
  // their own program (department-wide schedules are admin-only, mirroring
  // the events rule). Admins own what they create and may use any scope.
  const isAdmin = account.role === "ADMIN";
  let program = data.program ?? null;

  if (!isAdmin) {
    if (!account.program) {
      return forbidden(
        "Your account has no program assigned. Ask an administrator to set your program before creating schedules.",
      );
    }
    if (program && program !== account.program) {
      return forbidden(
        `You can only create schedules for the ${account.program} program.`,
      );
    }
    program = account.program;
  }

  try {
    // Department-wide rows (program=null) are never section-scoped - that
    // combination would be an orphan scope no student visibility predicate
    // matches. Force section=null when no program is set.
    const finalSection = program ? (data.section ?? null) : null;
    const schedule = await db.schedule.create({
      data: {
        ownerId: account.id,
        program,
        section: finalSection,
        shift: data.shift,
        dayOfWeek: data.dayOfWeek,
        subject: data.subject,
        instructor: data.instructor ?? null,
        room: data.room ?? null,
        startTime: data.startTime,
        endTime: data.endTime,
        isActive: data.isActive ?? true,
      },
      select: { id: true },
    });

    await audit({
      actorId: account.id,
      action: "schedule.create",
      targetType: "Schedule",
      targetId: schedule.id,
      metadata: {
        program,
        section: finalSection,
        shift: data.shift,
        dayOfWeek: data.dayOfWeek,
        subject: data.subject,
      },
      req,
    });

    return NextResponse.json({ id: schedule.id }, { status: 201 });
  } catch (e) {
    if (isUniqueConstraintError(e)) {
      return conflict(
        "This exact class slot already exists for that section, day, and start time.",
        "DUPLICATE_SCHEDULE",
      );
    }
    if (isSchemaDriftError(e)) return dbSchemaDrift(e);
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    throw e;
  }
}
