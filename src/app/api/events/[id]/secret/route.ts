import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, notFound, requireAuth } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getEventTimeWindow } from "@/lib/event-time";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/events/[id]/secret
// Returns the eventSecret so the projector can generate rotating QR tokens
// locally (Method 1 — HMAC-SHA256, 2 FPS sub-frame rotation).
//
// ================================================================
// STRICT QR DELEGATION RULES (v10 — organization tag enforced)
// ================================================================
//
//   - ADMIN: can project ANY event (bypasses all delegation checks)
//   - EVENT OWNER: can always project their own event
//   - OTHER ORGANIZER: can project ONLY IF ALL of the following are true:
//
//       1. The organizer has a non-empty `organizationName` tag set.
//          → If the admin has NOT set an org tag on the organizer's
//            account, delegation is COMPLETELY DISABLED. The admin must
//            add the org tag first.
//
//       2. The event's `delegationEnabled` flag is true (admin-controlled).
//          → Default is false. The admin must explicitly enable it.
//
//       3. The event owner ALSO has a non-empty `organizationName` tag.
//          → If the event owner has no org tag, delegation is blocked
//            (even if the requesting organizer has one).
//
//       4. The organizer's org tag MATCHES the event owner's org tag.
//          → e.g. both are "College of Technology"
//          → This applies to BOTH open-to-all AND course-specific events.
//            There is no exception for open-to-all — the org tag must
//            always match.
//
//   If ANY of these conditions fail, the organizer gets a 403 with a
//   specific error message explaining which condition failed.
//
// ================================================================

export async function GET(req: NextRequest, { params }: Ctx) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;
  const { id } = await params;

  const event = await db.event.findUnique({
    where: { id: Number(id) },
    select: {
      id: true,
      title: true,
      eventSecret: true,
      scheduledAt: true,
      endsAt: true,
      checkInOpensAt: true,
      checkInClosesAt: true,
      targetProgram: true,
      targetSection: true,
      scope: true,
      ownerId: true,
      status: true,
      delegatable: true,
      delegationEnabled: true,
    },
  });
  if (!event) return notFound("Event not found");

  // ---- Authorization: who can project this event's QR? ----
  const isOwner = event.ownerId === account.id;
  const isAdmin = account.role === "ADMIN";
  let isDelegated = false;
  let delegationMode = "owner"; // "owner" | "admin" | "same_organization"

  if (isAdmin) {
    delegationMode = "admin";
  } else if (isOwner) {
    delegationMode = "owner";
  } else {
    // ---- OTHER ORGANIZER: strict delegation checks ----

    // CHECK 1: Organizer MUST have an organization tag.
    // If the admin has not set an org tag on this organizer's account,
    // delegation is COMPLETELY DISABLED — no exceptions, not even for
    // open-to-all events. The admin must add the org tag first.
    const organizerOrg = account.organizationName?.trim();
    if (!organizerOrg) {
      return forbidden(
        "QR delegation is disabled for your account because you have no organization tag. An administrator must set your organization tag before you can project another organizer's QR code.",
      );
    }

    // CHECK 2: The event's delegationEnabled flag must be true.
    if (!event.delegationEnabled) {
      return forbidden(
        "QR delegation is not enabled for this event. Only the event creator or an administrator can project this QR code.",
      );
    }

    // CHECK 3: The event OWNER must also have an organization tag.
    const owner = await db.account.findUnique({
      where: { id: event.ownerId },
      select: { organizationName: true },
    });
    const ownerOrg = owner?.organizationName?.trim();
    if (!ownerOrg) {
      return forbidden(
        "QR delegation is blocked because the event creator has no organization tag. The administrator must set the event creator's organization tag before delegation can be used.",
      );
    }

    // CHECK 4: The organizer's org tag MUST match the event owner's org tag.
    // This applies to ALL events (both open-to-all and course-specific).
    // There is NO exception for open-to-all events.
    if (ownerOrg !== organizerOrg) {
      return forbidden(
        `You can only delegate QR projection within the same organization. The event creator is tagged "${ownerOrg}" but you are tagged "${organizerOrg}". Contact your administrator if this is incorrect.`,
      );
    }

    // All checks passed — delegation is allowed.
    isDelegated = true;
    delegationMode = "same_organization";

    // Audit the delegated projection so there's a trail of which
    // organizer projected another organizer's event.
    await audit({
      actorId: account.id,
      action: "event.qr_delegated",
      targetType: "Event",
      targetId: event.id,
      metadata: {
        eventId: event.id,
        eventTitle: event.title,
        ownerId: event.ownerId,
        delegateId: account.id,
        organizationTag: organizerOrg,
        delegationMode,
      },
      req,
    });
  }

  if (event.status !== "active") {
    return forbidden("This event is no longer active");
  }

  // Use the shared time-window helper
  const window = getEventTimeWindow(event);

  if (window.isUpcoming) {
    const opensInMs = window.opensAt.getTime() - Date.now();
    const opensInMinutes = Math.ceil(opensInMs / (60 * 1000));
    return NextResponse.json(
      {
        error: "This event hasn't opened for check-in yet.",
        code: "UPCOMING",
        opensInMs,
        opensInMinutes,
        opensAt: window.opensAt.toISOString(),
        closesAt: window.closesAt.toISOString(),
      },
      { status: 403 },
    );
  }

  if (window.isEnded) {
    return NextResponse.json(
      {
        error: "This event's check-in window has closed.",
        code: "ENDED",
        closesAt: window.closesAt.toISOString(),
      },
      { status: 403 },
    );
  }

  // Event is live — return the secret
  return NextResponse.json(
    {
      id: event.id,
      title: event.title,
      eventSecret: event.eventSecret,
      scheduledAt: event.scheduledAt,
      endsAt: event.endsAt,
      checkInOpensAt: event.checkInOpensAt,
      checkInClosesAt: event.checkInClosesAt,
      targetProgram: event.targetProgram,
      targetSection: event.targetSection,
      scope: event.scope,
      windowOpensAt: window.opensAt,
      windowClosesAt: window.closesAt,
      isDelegated,
      delegatable: event.delegatable,
      delegationEnabled: event.delegationEnabled,
      delegationMode,
    },
    { headers: { "Cache-Control": "private, no-cache" } },
  );
}
