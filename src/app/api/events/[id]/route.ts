import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  badRequest,
  forbidden,
  notFound,
  parseBody,
  requireAuth,
} from "@/lib/api";
import { updateEventSchema } from "@/lib/validation";
import { audit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/events/[id]
// SECURITY: Never returns eventSecret to USER accounts — they could forge
// QR tokens with it. Only ORGANIZER (owner) and ADMIN see the secret.
export async function GET(_req: NextRequest, { params }: Ctx) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;
  const { id } = await params;

  // Determine if this account is allowed to see the eventSecret
  const canSeeSecret = account.role === "ADMIN" || account.role === "ORGANIZER";

  const event = await db.event.findUnique({
    where: { id: Number(id) },
    select: {
      id: true,
      title: true,
      description: true,
      // eventSecret ONLY included for ORGANIZER/ADMIN (to project QR codes)
      ...(canSeeSecret ? { eventSecret: true } : {}),
      ownerId: true,
      owner: { select: { id: true, fullName: true } },
      scope: true,
      targetProgram: true,
      targetSection: true,
      scheduledAt: true,
      endsAt: true,
      checkInOpensAt: true,
      checkInClosesAt: true,
      timeOutOpensAt: true,
      timeOutClosesAt: true,
      enableTimeOut: true,
      delegatable: true,
      delegationEnabled: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { attendances: true } },
    },
  });
  if (!event) return notFound("Event not found");

  if (account.role === "ORGANIZER" && event.ownerId !== account.id) {
    return forbidden("You can only view your own events");
  }
  if (account.role === "USER") {
    // STRICT visibility (mirrors GET /api/events list scoping):
    // Open-to-all OR exact program+section match. Program-wide events
    // (targetProgram set, targetSection null) are HIDDEN from students.
    const isOpenToAll = !event.targetProgram && !event.targetSection;
    const isExactMatch =
      !!event.targetProgram &&
      !!event.targetSection &&
      event.targetProgram === account.program &&
      event.targetSection === account.section;
    if (!isOpenToAll && !isExactMatch)
      return forbidden("This event isn't available to you");
  }

  return NextResponse.json(event, {
    headers: {
      "Cache-Control": "private, s-maxage=15, stale-while-revalidate=60",
    },
  });
}

// PATCH /api/events/[id]
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;
  const { id } = await params;

  const event = await db.event.findUnique({ where: { id: Number(id) } });
  if (!event) return notFound("Event not found");
  if (account.role !== "ADMIN" && event.ownerId !== account.id) {
    return forbidden("You can only edit your own events");
  }

  const body = await parseBody(req);
  const parsed = updateEventSchema.safeParse(body);
  if (!parsed.success)
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;

  // Prevent setting scheduledAt to a past date
  if (d.scheduledAt && new Date(d.scheduledAt) < new Date()) {
    return badRequest("The scheduled time must be in the future");
  }

  // Organizers can only target their own program/section (same as POST)
  let targetProgram = d.targetProgram;
  let targetSection = d.targetSection;
  if (account.role === "ORGANIZER") {
    if (
      targetProgram !== undefined &&
      targetProgram &&
      account.program &&
      targetProgram !== account.program
    ) {
      return forbidden(`You can only target the ${account.program} program.`);
    }
    if (
      targetSection !== undefined &&
      targetSection &&
      account.section &&
      targetSection !== account.section
    ) {
      return forbidden(`You can only target section ${account.section}.`);
    }
  }

  // If scope is being changed to departmental, clear program/section
  const effectiveScope = d.scope ?? event.scope;
  if (effectiveScope === "departmental") {
    targetProgram = null;
    targetSection = null;
  }

  const updated = await db.event.update({
    where: { id: Number(id) },
    data: {
      ...(d.title !== undefined ? { title: d.title } : {}),
      ...(d.description !== undefined ? { description: d.description } : {}),
      ...(d.scope !== undefined ? { scope: d.scope } : {}),
      ...(targetProgram !== undefined ? { targetProgram } : {}),
      ...(targetSection !== undefined ? { targetSection } : {}),
      ...(d.scheduledAt !== undefined
        ? { scheduledAt: new Date(d.scheduledAt) }
        : {}),
      ...(d.endsAt !== undefined
        ? { endsAt: d.endsAt ? new Date(d.endsAt) : null }
        : {}),
      ...(d.checkInOpensAt !== undefined
        ? {
            checkInOpensAt: d.checkInOpensAt
              ? new Date(d.checkInOpensAt)
              : null,
          }
        : {}),
      ...(d.checkInClosesAt !== undefined
        ? {
            checkInClosesAt: d.checkInClosesAt
              ? new Date(d.checkInClosesAt)
              : null,
          }
        : {}),
      ...(d.enableTimeOut !== undefined
        ? { enableTimeOut: d.enableTimeOut }
        : {}),
      ...(d.timeOutOpensAt !== undefined
        ? {
            timeOutOpensAt: d.timeOutOpensAt
              ? new Date(d.timeOutOpensAt)
              : null,
          }
        : {}),
      ...(d.timeOutClosesAt !== undefined
        ? {
            timeOutClosesAt: d.timeOutClosesAt
              ? new Date(d.timeOutClosesAt)
              : null,
          }
        : {}),
      ...(d.delegatable !== undefined ? { delegatable: d.delegatable } : {}),
      ...(d.delegationEnabled !== undefined
        ? { delegationEnabled: d.delegationEnabled }
        : {}),
    },
  });

  await audit({
    actorId: account.id,
    action: "event.update",
    targetType: "Event",
    targetId: updated.id,
    req,
  });

  return NextResponse.json(updated);
}

// DELETE /api/events/[id]
// - ?hard=true → permanent deletion (ADMIN only) — removes event + all attendance
// - default → soft delete (status="cancelled") — preserves attendance records
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const hardDelete = searchParams.get("hard") === "true";

  const event = await db.event.findUnique({ where: { id: Number(id) } });
  if (!event) return notFound("Event not found");
  if (account.role !== "ADMIN" && event.ownerId !== account.id) {
    return forbidden("You can only delete your own events");
  }

  if (hardDelete) {
    // Hard delete — ADMIN only. Permanently removes the event and all
    // associated attendance records and overrides (via cascade).
    if (account.role !== "ADMIN") {
      return forbidden("Only administrators can permanently delete events.");
    }
    await db.event.delete({ where: { id: Number(id) } });
    await audit({
      actorId: account.id,
      action: "event.hard_delete",
      targetType: "Event",
      targetId: Number(id),
      metadata: { title: event.title },
      req,
    });
    return NextResponse.json({ ok: true, deleted: true });
  }

  // Soft delete — marks as cancelled, preserves attendance records
  await db.event.update({
    where: { id: Number(id) },
    data: { status: "cancelled" },
  });

  await audit({
    actorId: account.id,
    action: "event.cancel",
    targetType: "Event",
    targetId: Number(id),
    req,
  });

  return NextResponse.json({ ok: true });
}
