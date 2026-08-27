import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  badRequest,
  checkRateLimitByKey,
  conflict,
  dbSchemaDrift,
  dbUnavailable,
  forbidden,
  isDbUnavailableError,
  notFound,
  parseBody,
  requireAuth,
} from "@/lib/api";
import { overrideCertificateSchema } from "@/lib/validation";
import { audit } from "@/lib/audit";
import { notifyAttendance } from "@/lib/realtime";
import { getEventTimeWindows } from "@/lib/event-time";
import {
  isSchemaDriftError,
  isUniqueConstraintError,
} from "@/lib/prisma-errors";
import { verifySignedOverrideCertificate } from "@/lib/device-key-server";
import {
  validateOverrideTimestamp,
  deriveOverrideIdempotencyKey,
  type SignedOverrideCertificate,
} from "@/lib/override-certificate";

// Allow extra time for the Ed25519 verify + transaction under load.
export const maxDuration = 30;

// ====================================================================
// POST /api/attendance/override - signed override certificate (v16)
// --------------------------------------------------------------------
// OFFLINE-FIRST, CHEAT-RESISTANT manual attendance overrides.
//
// WHO: ORGANIZER (own events only) or ADMIN (any event). requireAuth is
// hierarchical, so requireAuth("ORGANIZER") admits both; USER gets 403.
//
// WHAT: The client creates an OverrideCertificate {eventId, studentId,
// reason, createdAt, nonce, deviceFingerprint}, signs it with the
// device's Ed25519 private key, and either submits immediately (online)
// or queues it in localStorage and syncs later (offline). The SIGNED
// createdAt is the time anchor - the moment the organizer made the
// decision - decoupled from when the server receives it.
//
// THREAT MODEL (defenses in order of execution):
//   T7 privilege escalation (student hits endpoint) -> requireAuth gate
//   T6 cross-organizer escalation                   -> ownership check
//   T2 queue tampering                              -> Ed25519 signature +
//                                                     canonical round-trip
//   T5 clock manipulation                           -> skew limits on the
//                                                     signed createdAt
//   T4 retroactive fabrication                      -> 24h sync deadline
//   T1 fabricated in-window entries                 -> window-at-creation
//                                                     + rate limit + audit
//                                                     forensics (drift,
//                                                     delay, device, role)
//   T3 replay/duplicate                             -> deterministic
//                                                     idempotency key +
//                                                     unique(eventId,
//                                                     studentId)
//
// SERVER-SIDE VALIDATIONS (cannot be bypassed by the client):
//   1. Zod schema validation (overrideCertificateSchema)
//   2. Event existence (404 fail-fast)
//   3. Event ownership (ORGANIZER must own the event - 403 fail-fast,
//      checked BEFORE expensive crypto)
//   4. Ed25519 signature verification (device key must be registered +
//      not revoked + fingerprint recomputed + canonical round-trip)
//   5. Certificate timestamp validation (skew + 24h sync deadline)
//   6. Event active + time window at the SIGNED createdAt (offline-first:
//      the check-in OR time-out window must have been live when the
//      organizer made the decision, NOT at sync time)
//   7. Student eligibility (whitelist FK-enforced + program/section match
//      + active, non-deactivated account)
//   8. Atomic transaction (override + attendance upsert)
//   9. Unique constraint (eventId, studentId) - duplicate override -> 409
//  10. Audit log with full anti-cheat forensics
// ====================================================================

// Server-derived threshold: an override synced more than 2 minutes after
// its signed creation time was almost certainly created offline. NOT
// client-claimed (a client can lie about being offline; the signed
// timestamp cannot).
const OFFLINE_FLAG_THRESHOLD_MS = 120_000;

export async function POST(req: NextRequest) {
  // ---- Authenticate (ORGANIZER or ADMIN; USER -> 403) ----
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;

  // ---- Rate limit (fail-closed preset - see rate-limit.ts) ----
  const rl = await checkRateLimitByKey(account.id, "override");
  if (rl) return rl;

  // ---- Parse + validate the signed certificate (Zod) ----
  const body = await parseBody(req);
  const parsed = overrideCertificateSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      parsed.error.issues[0]?.message ?? "Invalid override certificate",
    );
  }
  const signed: SignedOverrideCertificate = parsed.data;
  const cert = signed.certificate;

  // ---- Event existence (fail-fast before expensive crypto) ----
  const event = await db.event.findUnique({ where: { id: cert.eventId } });
  if (!event) return notFound("Event not found");

  // ---- Ownership (fail-fast BEFORE expensive crypto) ----
  // Organizers may only create overrides for events they own. Admins
  // may override any event (admin verification is the escalation path).
  if (account.role !== "ADMIN" && event.ownerId !== account.id) {
    return forbidden(
      "You can only add manual entries for events you organize.",
    );
  }

  // ---- Verify the Ed25519 signature (device key + canonical match) ----
  const sigResult = await verifySignedOverrideCertificate(signed);
  if (!sigResult.ok) {
    return badRequest(
      sigResult.reason === "device_not_registered"
        ? "This device is not registered. Refresh the page and try again."
        : sigResult.reason === "device_revoked"
          ? "This device has been revoked. Contact an administrator."
          : "Override certificate verification failed. The entry may have been tampered with.",
      "INVALID_CERTIFICATE",
    );
  }

  // ---- Account↔device binding (anti-proxy / anti-laundering) ----
  // The signing device key MUST belong to the authenticated account.
  // Without this check, a certificate signed by account A's device could
  // be submitted under account B's session (e.g. a signed cert handed to
  // a colluding organizer), recording creatorId=B while the cryptographic
  // evidence was produced by A's key - a misleading forensic trail and a
  // cross-account certificate-injection vector. Legitimate flows are
  // unaffected: the client always signs with the session account's own
  // IndexedDB keypair (per-account scoping in device-key-client.ts).
  if (sigResult.deviceKey?.accountId !== account.id) {
    return badRequest(
      "This certificate was signed by a different account's device. Sign the entry on your own device.",
      "INVALID_CERTIFICATE",
    );
  }

  // ---- Validate the certificate timestamp (skew + sync deadline) ----
  const tsResult = validateOverrideTimestamp(cert);
  if (!tsResult.ok) {
    return badRequest(
      tsResult.reason === "scanned_in_future"
        ? "Your device clock is too far ahead. Sync your time settings and try again."
        : "This entry is too old to sync. Offline entries must be synced within 24 hours.",
      tsResult.reason?.toUpperCase(),
    );
  }

  // ---- Event must still be active ----
  if (event.status !== "active") {
    return forbidden("This event is no longer active");
  }

  // ---- Time window AT THE SIGNED CREATION TIME (offline-first) ----
  // The organizer must have made the decision while the check-in OR
  // time-out window was live. We evaluate against cert.createdAt (the
  // signed moment of decision), NOT Date.now() - otherwise offline
  // entries synced after the window closes would all be rejected,
  // defeating offline-first. This also bounds fabrication: creating an
  // entry AFTER the windows closed requires forging the signed
  // timestamp (tamper-evident) or premeditation during the event
  // (auditable via the forensic columns).
  const windows = getEventTimeWindows(event);
  const createdMs = cert.createdAt;
  const inCheckIn =
    createdMs >= windows.checkIn.opensAt.getTime() &&
    createdMs <= windows.checkIn.closesAt.getTime();
  const inTimeOut = windows.timeOut
    ? createdMs >= windows.timeOut.opensAt.getTime() &&
      createdMs <= windows.timeOut.closesAt.getTime()
    : false;

  if (!inCheckIn && !inTimeOut) {
    if (windows.checkIn.isUpcoming) {
      return forbidden("This event hasn't opened for check-in yet.");
    }
    return forbidden("This event's check-in window has closed.");
  }

  // ---- Student eligibility (whitelist + active account) ----
  // The whitelist (AuthorizedStudent) is the single source of eligibility:
  // the AttendanceOverride.studentId foreign key REFERENCES it, and the
  // GET list / CSV exports join through that relation. An earlier draft
  // allowed an account-based fallback ("registered but not whitelisted"),
  // but that contradicts the schema: such a POST would pass these checks
  // and then die with an unhandled P2003 FK violation -> 500. Require the
  // whitelist row up front (clean 400) and keep the account lookup for the
  // attendance upsert (attendance is keyed by accountId, not studentId).
  const student = await db.authorizedStudent.findUnique({
    where: { studentId: cert.studentId },
  });
  if (!student) {
    return badRequest(
      "This student is not on the approved list for this event.",
      "NOT_WHITELISTED",
    );
  }
  const studentProgram: string | null = student.program;
  const studentSection: string | null = student.section;

  const studentAccount = await db.account.findUnique({
    where: { studentId: cert.studentId },
  });

  // Strict program/section match against the event's targeting.
  if (event.targetProgram && studentProgram !== event.targetProgram) {
    return forbidden("This student is not eligible for this event");
  }
  if (event.targetSection && studentSection !== event.targetSection) {
    return forbidden("This student is not eligible for this event");
  }

  // An attendance row requires an account (attendance is keyed by
  // accountId, not studentId).
  if (!studentAccount) {
    return badRequest(
      "This student has not created an account yet.",
      "NO_ACCOUNT",
    );
  }

  // A deactivated (soft-deleted) account must not receive attendance.
  // Deactivation removes the student from the roster, but their whitelist
  // row may linger - without this guard an organizer could (accidentally
  // or otherwise) create attendance for a student who has left, polluting
  // rosters, CSV exports and analytics with rows admins must clean up.
  // PENDING_VERIFICATION / SUSPENDED accounts remain overridable: those
  // students are still enrolled (verification lag is a normal reason to
  // need an override).
  if (studentAccount.isDeactivated || studentAccount.status === "DEACTIVATED") {
    return forbidden(
      "This student's account has been deactivated and can no longer receive attendance.",
    );
  }

  // ---- Forensics (all server-derived from the signed timestamp) ----
  const now = Date.now();
  const syncDelayMs = now - cert.createdAt;
  const clockDriftMs = syncDelayMs; // same computation; stored twice for
  // query ergonomics: syncDelayMs powers the offline heuristic,
  // clockDriftMs documents client-vs-server drift in the audit trail.
  const offline = syncDelayMs > OFFLINE_FLAG_THRESHOLD_MS;
  const idempotencyKey = deriveOverrideIdempotencyKey(cert);

  let result;
  try {
    result = await db.$transaction(async (tx) => {
      const override = await tx.attendanceOverride.create({
        data: {
          eventId: cert.eventId,
          creatorId: account.id,
          studentId: cert.studentId,
          reason: cert.reason,
          clientCreatedAt: new Date(cert.createdAt),
          deviceFingerprint: cert.deviceFingerprint,
          syncDelayMs,
          clockDriftMs,
          offline,
        },
      });
      const attendance = await tx.eventAttendance.upsert({
        where: {
          eventId_accountId: {
            eventId: cert.eventId,
            accountId: studentAccount.id,
          },
        },
        // M1 fix (preserved from the plain-admin era): when the student
        // already has a QR-scanned attendance row, the override must mark
        // it as override-sourced so CSV exports + analytics reflect the
        // manual correction. scannedAt is stamped with the SIGNED
        // creation time (offline-first: the moment the organizer made
        // the decision, not the sync time).
        update: {
          source: "override",
          scannedAt: new Date(cert.createdAt),
        },
        create: {
          eventId: cert.eventId,
          accountId: studentAccount.id,
          source: "override",
          idempotencyKey,
          deviceFingerprint: cert.deviceFingerprint,
          scannedAtClient: new Date(cert.createdAt),
        },
      });
      return { override, attendance };
    });
  } catch (e) {
    // P2002 = unique constraint violation (duplicate override on retry
    // or a race between two syncs). Use the stable Prisma error code
    // instead of a fragile string match.
    if (isUniqueConstraintError(e)) {
      return conflict(
        "This student already has an override for this event.",
        "ALREADY_OVERRIDDEN",
      );
    }
    // P2003 = FK violation. Defense-in-depth: if the whitelist row is
    // deleted between the eligibility check above and the transaction
    // (admin concurrently prunes the roster), return a clean 400 instead
    // of an unhandled 500.
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code: string }).code === "P2003"
    ) {
      return badRequest(
        "This student is not on the approved list for this event.",
        "NOT_WHITELISTED",
      );
    }
    // P2021/P2022 = the live DB is missing the attendance_overrides
    // table or its v16 forensics columns (schema pushed from a stale
    // checkout). Return a self-diagnosing 503 so the organizer sees an
    // actionable message (and the offline queue surfaces it) instead of
    // an opaque 500 loop.
    if (isSchemaDriftError(e)) return dbSchemaDrift(e);
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    throw e;
  }

  // ---- Realtime roster update (fire-and-forget) ----
  notifyAttendance(cert.eventId, {
    id: result.attendance.id,
    accountId: studentAccount.id,
    fullName: studentAccount.fullName,
    studentId: studentAccount.studentId,
    program: studentAccount.program,
    section: studentAccount.section,
    scannedAt: new Date(cert.createdAt).toISOString(),
    source: "override",
  }).catch(() => {});

  // ---- Audit log with full anti-cheat forensics ----
  await audit({
    actorId: account.id,
    action: "attendance.override",
    targetType: "EventAttendance",
    targetId: result.attendance.id,
    metadata: {
      eventId: cert.eventId,
      studentId: cert.studentId,
      reason: cert.reason,
      deviceFingerprint: cert.deviceFingerprint,
      driftMs: clockDriftMs,
      syncDelayMs,
      offline,
      role: account.role,
    },
    req,
  });

  return NextResponse.json(
    {
      ok: true,
      action: "created",
      override: { id: result.override.id },
      attendance: { id: result.attendance.id },
      offline,
      message: "Student marked as present.",
    },
    { status: 201 },
  );
}
