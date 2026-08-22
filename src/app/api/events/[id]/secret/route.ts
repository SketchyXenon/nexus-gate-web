import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, notFound, requireAuth } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getEventTimeWindows } from "@/lib/event-time";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/events/[id]/secret
// Returns the eventSecret so the projector can generate rotating QR tokens
// locally (Method 1 - HMAC-SHA256, 2 FPS sub-frame rotation).
//
// ================================================================
// STRICT QR DELEGATION RULES (program-scoped, program-wide only)
// ================================================================
//
//  - ADMIN: can project ANY event (bypasses all delegation checks)
//  - EVENT OWNER: can always project their own event
//  - OTHER ORGANIZER: can project ONLY IF ALL of the following are true:
//
//       1. The event is NOT department-wide (open-to-all). Open-to-all
//          events target the whole department, so delegating their QR is
//          unnecessary privilege - the owner/admin projects them.
//
//       2. The event is NOT section-specific ("specified"). A single
//          section is small enough that only the owner/admin projects it.
//          => Delegation is allowed ONLY for program-wide events
//             (scope=academic, targetProgram set, targetSection null).
//
//       3. The owner has opted in (event.delegatable === true).
//
//       4. The delegate organizer has a program, and it MATCHES the
//          event's targetProgram (identical program alignment). e.g. both
//          are BSIT organizers projecting a BSIT program-wide event.
//
//   If ANY condition fails, the organizer gets a 403 with a specific
//   error message (and code) explaining which condition failed.
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
      timeOutOpensAt: true,
      timeOutClosesAt: true,
      enableTimeOut: true,
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
  let delegationMode = "owner"; // "owner" | "admin" | "same_program"
  let delegateProgram = ""; // program used for delegated projection audit

  if (isAdmin) {
    delegationMode = "admin";
  } else if (isOwner) {
    delegationMode = "owner";
  } else {
    // ---- OTHER ORGANIZER: program-scoped delegation ----

    // CHECK 1: Department-wide (open-to-all) events are NEVER delegatable.
    // They target the whole department, so letting another organizer project
    // their QR is unnecessary privilege - the owner/admin handles it.
    if (event.scope === "departmental") {
      return NextResponse.json(
        {
          error:
            "QR delegation is not available for department-wide events. Departmental events are open to everyone - only the event creator or an administrator can project this QR code.",
          code: "DELEGATION_DEPARTMENTAL_DISABLED",
        },
        { status: 403 },
      );
    }

    // CHECK 2: Section-specific ("specified") events are NEVER delegatable.
    // A single section is small enough that only the owner/admin projects it.
    if (event.targetSection) {
      return NextResponse.json(
        {
          error:
            "QR delegation is not available for section-specific events. Only program-wide events can be delegated - leave the section blank when creating the event to enable delegation.",
          code: "DELEGATION_SECTION_DISABLED",
        },
        { status: 403 },
      );
    }

    // Delegation requires a program-wide event (targetProgram set, no section).
    if (!event.targetProgram) {
      return forbidden(
        "QR delegation is only available for program-wide events.",
      );
    }

    // CHECK 3: The owner must have opted in (delegatable flag).
    if (!event.delegatable) {
      return forbidden(
        "The event creator has not enabled QR delegation for this event. Only the event creator or an administrator can project this QR code.",
      );
    }

    // CHECK 4: The delegate organizer must have a program that MATCHES the
    // event's targetProgram (identical program alignment).
    const organizerProgram = account.program?.trim();
    if (!organizerProgram) {
      return forbidden(
        "Your account has no program assigned. An administrator must set your program before you can delegate QR projection.",
      );
    }
    if (organizerProgram !== event.targetProgram) {
      return forbidden(
        `You can only delegate QR projection within your own program. This event is for the ${event.targetProgram} program but your program is ${organizerProgram}.`,
      );
    }

    // All checks passed - delegation is allowed.
    isDelegated = true;
    delegationMode = "same_program";
    delegateProgram = organizerProgram;
  }

  if (event.status !== "active") {
    return forbidden("This event is no longer active");
  }

  // Use the shared time-window helper (plural - includes time-out window).
  const windows = getEventTimeWindows(event);
  const checkInWindow = windows.checkIn;
  const timeOutWindow = windows.timeOut;

  // If neither window is live, determine which error to show.
  if (!checkInWindow.isLive && !timeOutWindow?.isLive) {
    if (checkInWindow.isUpcoming) {
      const opensInMs = checkInWindow.opensAt.getTime() - Date.now();
      const opensInMinutes = Math.ceil(opensInMs / (60 * 1000));
      return NextResponse.json(
        {
          error: "This event hasn't opened for check-in yet.",
          code: "UPCOMING",
          opensInMs,
          opensInMinutes,
          opensAt: checkInWindow.opensAt.toISOString(),
          closesAt: checkInWindow.closesAt.toISOString(),
        },
        { status: 403 },
      );
    }

    const lastClosesAt = timeOutWindow
      ? timeOutWindow.closesAt > checkInWindow.closesAt
        ? timeOutWindow.closesAt
        : checkInWindow.closesAt
      : checkInWindow.closesAt;
    return NextResponse.json(
      {
        error: "This event's check-in window has closed.",
        code: "ENDED",
        closesAt: lastClosesAt.toISOString(),
      },
      { status: 403 },
    );
  }

  // At least one window is live - determine which mode we're in.
  const isCheckInLive = checkInWindow.isLive;
  const isTimeOutLive = timeOutWindow?.isLive ?? false;
  const activeWindow = isCheckInLive ? checkInWindow : timeOutWindow!;

  // Audit the delegated projection AFTER all guards pass, so the audit
  // trail only records successful secret disclosures (not rejected attempts).
  if (isDelegated) {
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
        delegateProgram,
        delegationMode,
      },
      req,
    });
  }

  // Event is live - return the secret
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
      windowOpensAt: activeWindow.opensAt,
      windowClosesAt: activeWindow.closesAt,
      isCheckInLive,
      isTimeOutLive,
      enableTimeOut: event.enableTimeOut,
      isDelegated,
      delegatable: event.delegatable,
      delegationEnabled: event.delegationEnabled,
      delegationMode,
    },
    { headers: { "Cache-Control": "private, no-cache" } },
  );
}
