import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { updateScheduleSchema } from "@/lib/validation";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
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
// PATCH/DELETE /api/schedules/[id] (ORGANIZER+)
// --------------------------------------------------------------------
// BOLA defense: an organizer may only modify schedule rows INSIDE their
// own program (ownership alone is not enough - a program row they own but
// that was re-scoped is still out of reach once it leaves their program).
// Admins may modify anything. Deletes are hard deletes: schedule rows
// have no dependent attendance data (unlike events).
// ====================================================================

type RouteContext = { params: Promise<{ id: string }> };

async function loadAuthorizedSchedule(
  id: number,
  accountId: string,
  isAdmin: boolean,
  program: string | null,
) {
  const schedule = await db.schedule.findUnique({ where: { id } });
  if (!schedule) return { error: notFound("Schedule not found") };
  if (!isAdmin) {
    if (!program || schedule.program !== program) {
      return {
        error: forbidden("You can only manage schedules for your own program."),
      };
    }
  }
  return { schedule, accountId };
}

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;

  const rl = await checkRateLimitByKey(account.id, "adminMutation");
  if (rl) return rl;

  const { id: rawId } = await ctx.params;
  const id = Number(rawId);
  if (!Number.isFinite(id)) return notFound("Schedule not found");

  const body = await parseBody(req);
  const parsed = updateScheduleSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  }

  const guard = await loadAuthorizedSchedule(
    id,
    account.id,
    account.role === "ADMIN",
    account.program,
  );
  if ("error" in guard) return guard.error;

  const data = parsed.data;
  // Department-wide rows (program=null) are never section-scoped - that
  // combination would be an orphan scope no student visibility predicate
  // matches. Force section=null when the program is null.
  const finalProgram =
    data.program !== undefined
      ? (data.program ?? null)
      : guard.schedule.program;
  const finalSection =
    finalProgram === null
      ? null
      : data.section !== undefined
        ? (data.section ?? null)
        : guard.schedule.section;
  try {
    const updated = await db.schedule.update({
      where: { id },
      data: {
        ...(data.program !== undefined ? { program: finalProgram } : {}),
        ...(data.section !== undefined || data.program !== undefined
          ? { section: finalSection }
          : {}),
        ...(data.shift !== undefined ? { shift: data.shift } : {}),
        ...(data.dayOfWeek !== undefined ? { dayOfWeek: data.dayOfWeek } : {}),
        ...(data.subject !== undefined ? { subject: data.subject } : {}),
        ...(data.instructor !== undefined
          ? { instructor: data.instructor ?? null }
          : {}),
        ...(data.room !== undefined ? { room: data.room ?? null } : {}),
        ...(data.startTime !== undefined ? { startTime: data.startTime } : {}),
        ...(data.endTime !== undefined ? { endTime: data.endTime } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
      select: { id: true },
    });

    await audit({
      actorId: account.id,
      action: "schedule.update",
      targetType: "Schedule",
      targetId: updated.id,
      metadata: data,
      req,
    });

    return Response.json({ ok: true });
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

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;

  const rl = await checkRateLimitByKey(account.id, "adminMutation");
  if (rl) return rl;

  const { id: rawId } = await ctx.params;
  const id = Number(rawId);
  if (!Number.isFinite(id)) return notFound("Schedule not found");

  const guard = await loadAuthorizedSchedule(
    id,
    account.id,
    account.role === "ADMIN",
    account.program,
  );
  if ("error" in guard) return guard.error;

  try {
    await db.schedule.delete({ where: { id } });
  } catch (e) {
    if (isSchemaDriftError(e)) return dbSchemaDrift(e);
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    return notFound("Schedule not found");
  }

  await audit({
    actorId: account.id,
    action: "schedule.delete",
    targetType: "Schedule",
    targetId: id,
    req,
  });

  return Response.json({ ok: true });
}
