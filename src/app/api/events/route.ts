import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createEventSchema } from "@/lib/validation";
import { badRequest, forbidden, parseBody, requireAuth } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getTimeStatus } from "@/lib/event-time";
import {
  studentNeedsProfile,
  visibleEventWhereOr,
} from "@/lib/event-visibility";

// GET /api/events
// Returns active + upcoming events (not ended ones, to keep lists clean).
// Pass ?includeEnded=true to also see ended events (for history/archive).
//
// STRICT EVENT VISIBILITY (v7):
//
//   USER (student) sees an event if and only if:
//     1. OPEN TO ALL - both targetProgram AND targetSection are null, OR
//     2. EXACT COURSE+SECTION MATCH - targetProgram = student's program
//        AND targetSection = student's section (BOTH must match).
//   Program-wide events (targetSection null, targetProgram set) are HIDDEN
//   from students. If the student hasn't set their program/section, they
//   only see open-to-all events (and a `needsProfile` flag is returned).
//
//   ORGANIZER sees:
//     1. Open-to-all events, OR
//     2. Events in their own program (any section - for QR delegation), OR
//     3. Events that exactly match their program + section.
//
//   ADMIN sees ALL events (no filtering).
export async function GET(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  const { searchParams } = new URL(req.url);
  const scope = searchParams.get("scope") || undefined;
  const includeEnded = searchParams.get("includeEnded") === "true";
  // v16-B: server-side search by title (debounced on the client)
  const q = searchParams.get("q")?.trim() || undefined;
  // v16-B: status filter (active / upcoming / ended). When "ended" or "all"
  // is requested we implicitly turn on includeEnded so the post-filter can
  // keep ended rows instead of stripping them.
  const statusFilter = searchParams.get("status") || undefined; // "active" | "upcoming" | "ended" | "all"
  // v16-B: sort by scheduledAt - "newest" (desc, default) or "oldest" (asc)
  const sort = searchParams.get("sort") || "newest";
  const sortDir: "desc" | "asc" = sort === "oldest" ? "asc" : "desc";

  // Allow organizers/admins to see cancelled events via ?includeCancelled=true.
  const includeCancelled = searchParams.get("includeCancelled") === "true";
  const where: Record<string, unknown> =
    includeCancelled &&
    (account.role === "ADMIN" || account.role === "ORGANIZER")
      ? { status: { in: ["active", "cancelled"] } }
      : { status: "active" };
  if (scope) where.scope = scope;
  if (q) {
    // SQLite LIKE is case-insensitive for ASCII by default; for full
    // case-insensitivity across Unicode we lowercase both sides via
    // Prisma's `contains` mode. SQLite ignores the mode flag for ASCII
    // but the explicit `insensitive` mode is a no-op there.
    where.title = { contains: q };
  }

  // ---- Role-aware visibility filtering (v8) ----
  // USER + ORGANIZER share the same rule: open-to-all, program-wide in
  // the caller's program, or exact program+section match. This makes an
  // organizer's program-scoped event visible to every student in that
  // program (v7 hid program-wide events, silently breaking the flow).
  // ADMIN sees all active events (no filtering).
  if (account.role === "USER" || account.role === "ORGANIZER") {
    where.AND = [{ OR: visibleEventWhereOr(account.program, account.section) }];
  }

  // SECURITY: Never return eventSecret to USER accounts. Only
  // ORGANIZER/ADMIN need it (to project QR codes). Students could
  // forge valid QR tokens if they had the secret.
  // Organizers may only see the secret for events they OWN - disclosing
  // another organizer's secret here would let them project QR locally and
  // bypass the delegation gate in /api/events/[id]/secret (org-tag +
  // delegationEnabled + departmental POLP). Non-owned rows are stripped
  // below. Admins see all secrets.
  const canSeeSecret = account.role === "ADMIN" || account.role === "ORGANIZER";

  // Pagination: default page 1, 100 per page. Cap at 200 to prevent abuse.
  // Use Number() + isFinite to guard against NaN (parseInt("abc") = NaN).
  const rawPage = Number(searchParams.get("page") || "1");
  const rawPageSize = Number(searchParams.get("pageSize") || "100");
  const page =
    Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const pageSize =
    Number.isFinite(rawPageSize) && rawPageSize >= 1
      ? Math.min(200, Math.floor(rawPageSize))
      : 100;
  const skip = (page - 1) * pageSize;

  const [events, totalCount] = await Promise.all([
    db.event.findMany({
      where,
      orderBy: { scheduledAt: sortDir },
      take: pageSize,
      skip,
      select: {
        id: true,
        title: true,
        description: true,
        ...(canSeeSecret ? { eventSecret: true } : {}),
        ownerId: true,
        owner: { select: { fullName: true } },
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
        _count: { select: { attendances: true } },
      },
    }),
    db.event.count({ where }),
  ]);

  // Compute timeStatus and filter out ended events (unless includeEnded=true
  // or the client explicitly requested ended/all via ?status=).
  const effectiveIncludeEnded =
    includeEnded || statusFilter === "ended" || statusFilter === "all";

  const eventsWithStatus = events
    .map((e) => {
      // POLP: organizers only keep the secret for events they own. Admins
      // keep all. This is applied after fetch because the select is shared.
      const isOwnOrAdmin = account.role === "ADMIN" || e.ownerId === account.id;
      const { eventSecret: _stripped, ...rest } = e as typeof e & {
        eventSecret?: unknown;
      };
      return {
        ...(isOwnOrAdmin ? e : rest),
        timeStatus: getTimeStatus(e),
      };
    })
    .filter((e) => {
      if (effectiveIncludeEnded) return true;
      // Hide ended events from active lists (but keep cancelled hidden too)
      return e.timeStatus !== "ended";
    })
    .filter((e) => {
      // ---- Optional status filter (post-compute) ----
      //   "active"   → live (check-in currently open)
      //   "upcoming" → not yet open
      //   "ended"    → finished
      //   "all"      → no filter
      if (!statusFilter || statusFilter === "all") return true;
      if (statusFilter === "active") return e.timeStatus === "live";
      if (statusFilter === "upcoming") return e.timeStatus === "upcoming";
      if (statusFilter === "ended") return e.timeStatus === "ended";
      return true;
    });

  // Flag for the frontend: does this student need to complete their profile
  // (program + section) before they can see course-specific events?
  const needsProfile =
    account.role === "USER" &&
    studentNeedsProfile(account.program, account.section);

  return NextResponse.json(
    {
      events: eventsWithStatus,
      needsProfile,
      userProgram: account.program,
      userSection: account.section,
      pagination: {
        page,
        pageSize,
        total: totalCount,
        totalPages: Math.ceil(totalCount / pageSize),
      },
    },
    {
      headers: {
        "Cache-Control": "private, no-cache",
      },
    },
  );
}

// POST /api/events (ORGANIZER+)
export async function POST(req: NextRequest) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;

  const body = await parseBody(req);
  const parsed = createEventSchema.safeParse(body);
  if (!parsed.success)
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;

  if (new Date(d.scheduledAt) < new Date()) {
    return badRequest("The scheduled time must be in the future");
  }

  // Organizers can only target their own program/section.
  // Admins can target any.
  // Departmental events clear program/section (applies to everyone).
  let targetProgram =
    d.scope === "departmental" ? null : (d.targetProgram ?? null);
  let targetSection =
    d.scope === "departmental" ? null : (d.targetSection ?? null);
  if (account.role === "ORGANIZER" && d.scope !== "departmental") {
    // An organizer without a program can ONLY create open-to-all (no
    // targetProgram) events. Previously the guard short-circuited on null
    // account.program, allowing cross-program event creation.
    if (targetProgram && !account.program) {
      return forbidden(
        "Your account has no program assigned. Ask an admin to set your program before creating program-scoped events, or create a departmental event instead.",
      );
    }
    if (targetProgram && account.program && targetProgram !== account.program) {
      return forbidden(
        `You can only create events for the ${account.program} program.`,
      );
    }
    if (targetSection && account.section && targetSection !== account.section) {
      return forbidden(
        `You can only create events for section ${account.section}.`,
      );
    }
    // Default to the organizer's own program/section if not specified
    if (!targetProgram && account.program) targetProgram = account.program;
    if (!targetSection && account.section) targetSection = account.section;
  }

  const event = await db.event.create({
    data: {
      title: d.title,
      description: d.description ?? null,
      scope: d.scope,
      targetProgram,
      targetSection,
      scheduledAt: new Date(d.scheduledAt),
      endsAt: d.endsAt ? new Date(d.endsAt) : null,
      checkInOpensAt: d.checkInOpensAt ? new Date(d.checkInOpensAt) : null,
      checkInClosesAt: d.checkInClosesAt ? new Date(d.checkInClosesAt) : null,
      enableTimeOut: d.enableTimeOut ?? false,
      timeOutOpensAt: d.timeOutOpensAt ? new Date(d.timeOutOpensAt) : null,
      timeOutClosesAt: d.timeOutClosesAt ? new Date(d.timeOutClosesAt) : null,
      delegatable: d.delegatable ?? true,
      delegationEnabled: d.delegationEnabled ?? false,
      ownerId: account.id,
    },
  });

  await audit({
    actorId: account.id,
    action: "event.create",
    targetType: "Event",
    targetId: event.id,
    metadata: { title: event.title },
    req,
  });

  return NextResponse.json(event, { status: 201 });
}
