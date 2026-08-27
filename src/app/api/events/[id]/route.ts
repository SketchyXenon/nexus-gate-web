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
import { isEventVisibleToStudent } from "@/lib/event-visibility";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/events/[id]
// SECURITY: Never returns eventSecret to USER accounts - they could forge
// QR tokens with it. Only the event OWNER (organizer) and ADMIN see the
// secret. Other organizers may VIEW a non-owned event's metadata when the
// v8 visibility rule allows it (open-to-all / program-wide in their
// program / exact section match), but the secret is stripped - they must
// go through /api/events/[id]/secret for delegated QR projection.
export async function GET(_req: NextRequest, { params }: Ctx) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;
  const { id } = await params;

  // Malformed id (non-numeric/negative): treat as nonexistent resource,
  // not a 500. Guards the Prisma query below against NaN.
  const eventId = Number(id);
  if (!Number.isInteger(eventId) || eventId <= 0)
    return notFound("Event not found");

  // Select the secret for any ADMIN or ORGANIZER; it is stripped below for
  // organizers viewing events they do not own.
  const canSeeSecret = account.role === "ADMIN" || account.role === "ORGANIZER";

  const event = await db.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      title: true,
      description: true,
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

  if (account.role === "USER") {
    // v8 visibility (mirrors GET /api/events list scoping): open-to-all,
    // program-wide in the student's program, or exact program+section match.
    const visible = isEventVisibleToStudent({
      targetProgram: event.targetProgram,
      targetSection: event.targetSection,
      studentProgram: account.program,
      studentSection: account.section,
    });
    if (!visible) return forbidden("This event isn't available to you");
  } else if (account.role === "ORGANIZER" && event.ownerId !== account.id) {
    // Organizers may view metadata of non-owned events they're authorized
    // to see (v8 rule), but NOT the secret. The secret is stripped below.
    const visible = isEventVisibleToStudent({
      targetProgram: event.targetProgram,
      targetSection: event.targetSection,
      studentProgram: account.program,
      studentSection: account.section,
    });
    if (!visible) return forbidden("This event isn't available to you");
  }

  // POLP: strip the secret for organizers viewing events they don't own.
  const isOwnerOrAdmin =
    account.role === "ADMIN" || event.ownerId === account.id;
  const { eventSecret: _stripped, ...withoutSecret } = event as typeof event & {
    eventSecret?: unknown;
  };
  const payload = isOwnerOrAdmin ? event : withoutSecret;

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "private, no-cache",
    },
  });
}

// PATCH /api/events/[id]
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;
  const { id } = await params;
  const eventId = Number(id);
  if (!Number.isInteger(eventId) || eventId <= 0)
    return notFound("Event not found");

  const event = await db.event.findUnique({ where: { id: eventId } });
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

  // Organizers are limited to their own program scope (mirrors POST).
  let targetProgram = d.targetProgram;
  let targetSection = d.targetSection;
  if (account.role === "ORGANIZER") {
    if (!account.program) {
      return forbidden(
        "Your account has no program assigned. Ask an administrator to set your program before editing events.",
      );
    }
    // Organizers cannot switch an event to department-wide scope.
    if (d.scope === "departmental") {
      return forbidden(
        "Organizers can only manage events within their own program scope. Department-wide events can only be created by an administrator.",
      );
    }
    // If a program is being (re)set, it must be the organizer's own; we
    // also forbid clearing it to null (which would make the event open-to-all
    // and thus outside their scope).
    if (targetProgram !== undefined) {
      if (targetProgram && targetProgram !== account.program) {
        return forbidden(`You can only target the ${account.program} program.`);
      }
      targetProgram = account.program;
    }
  }

  // If scope is being changed to departmental, clear program/section
  const effectiveScope = d.scope ?? event.scope;
  if (effectiveScope === "departmental") {
    targetProgram = null;
    targetSection = null;
  }

  const updated = await db.event.update({
    where: { id: eventId },
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
// - ?hard=true → permanent deletion (ADMIN only) - removes event + all attendance
// - default → soft delete (status="cancelled") - preserves attendance records
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const hardDelete = searchParams.get("hard") === "true";
  const eventId = Number(id);
  if (!Number.isInteger(eventId) || eventId <= 0)
    return notFound("Event not found");

  const event = await db.event.findUnique({ where: { id: eventId } });
  if (!event) return notFound("Event not found");
  if (account.role !== "ADMIN" && event.ownerId !== account.id) {
    return forbidden("You can only delete your own events");
  }

  if (hardDelete) {
    // Hard delete - ADMIN only. Permanently removes the event and all
    // associated attendance records and overrides (via cascade).
    if (account.role !== "ADMIN") {
      return forbidden("Only administrators can permanently delete events.");
    }
    await db.event.delete({ where: { id: eventId } });
    await audit({
      actorId: account.id,
      action: "event.hard_delete",
      targetType: "Event",
      targetId: eventId,
      metadata: { title: event.title },
      req,
    });
    return NextResponse.json({ ok: true, deleted: true });
  }

  // Soft delete - marks as cancelled, preserves attendance records
  await db.event.update({
    where: { id: eventId },
    data: { status: "cancelled" },
  });

  await audit({
    actorId: account.id,
    action: "event.cancel",
    targetType: "Event",
    targetId: eventId,
    req,
  });

  return NextResponse.json({ ok: true });
}
