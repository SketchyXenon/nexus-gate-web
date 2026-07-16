import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  badRequest,
  checkRateLimitAuthed,
  forbidden,
  notFound,
  parseBody,
  requireAuth,
} from "@/lib/api";
import { scanCertificateSchema } from "@/lib/validation";
import {
  validateQrPayload,
  verifySubFrameLiveness,
  MIN_SUB_FRAMES,
} from "@/lib/qr-token";
import { verifySignedCertificate } from "@/lib/device-key-server";
import {
  validateCertificateTimestamp,
  validateCertificateEventMatch,
  deriveIdempotencyKey,
  type SignedCertificate,
} from "@/lib/scan-certificate";
import { notifyAttendance } from "@/lib/realtime";
import { audit } from "@/lib/audit";
import { getEventTimeWindows } from "@/lib/event-time";

// Allow up to 30s for scan processing under high concurrency.
export const maxDuration = 30;

// ====================================================================
// POST /api/attendance — scan QR token (v8 — signed certificate)
// --------------------------------------------------------------------
// ONE-ATTEMPT POLICY (strict):
//   After the first successful scan (time-in), ALL subsequent scan
//   attempts by the same student for the same event return:
//     { ok: true, alreadyPresent: true, action: "already_scanned",
//       message: "This QR was already scanned. You are already marked present." }
//
//   This is enforced ATOMICALLY by the unique constraint on
//   (eventId, accountId). There is no time-out via QR — if time-out
//   is needed, organizers use the manual override system.
//
// SERVER-SIDE VALIDATIONS (cannot be bypassed by the client):
//   1. Zod schema validation (scanCertificateSchema)
//   2. Ed25519 signature verification (device key must be registered)
//   3. Certificate timestamp validation (not too far in future/past)
//   4. Token HMAC validation (against certificate's scannedAt, not sync time)
//   5. Multi-frame liveness (at least MIN_SUB_FRAMES consecutive sub-frames)
//   6. Event match (certificate eventId = token eventId)
//   7. Event eligibility (program + section strict match)
//   8. Time window validation (check-in must be open)
//   9. Idempotency (deterministic key from certificate nonce)
//  10. Unique constraint (eventId, accountId) — atomic one-attempt enforcement
// ====================================================================

export async function POST(req: NextRequest) {
  // ---- Authenticate (STUDENT-ONLY) ----
  const res = await requireAuth("USER", { exactRole: true });
  if ("error" in res) return res.error;
  const { account } = res;

  // ---- Rate limit ----
  const rl = await checkRateLimitAuthed(req, account.id, "scan");
  if (rl) return rl;

  // ---- Parse + validate the signed certificate (Zod) ----
  const body = await parseBody(req);
  const parsed = scanCertificateSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      parsed.error.issues[0]?.message ?? "Invalid scan certificate",
    );
  }
  const signed: SignedCertificate = parsed.data;

  // ---- ONE-ATTEMPT CHECK (before any expensive crypto) ----
  // If the student already has an attendance record for this event,
  // check if this is a time-out scan (student already checked in,
  // time-out window is live, and timeOutAt hasn't been set yet).
  const existing = await db.eventAttendance.findUnique({
    where: {
      eventId_accountId: {
        eventId: signed.certificate.eventId,
        accountId: account.id,
      },
    },
  });
  if (existing) {
    // If the student already has BOTH scannedAt AND timeOutAt, they're done.
    if (existing.timeOutAt) {
      return NextResponse.json({
        ok: true,
        alreadyPresent: true,
        action: "already_complete",
        scannedAt: existing.scannedAt,
        timeOutAt: existing.timeOutAt,
        message: "You've already checked in and timed out for this event.",
      });
    }

    // Student has checked in but not timed out. Check if the time-out
    // window is live. If yes, record the time-out. If no, return "already scanned."
    const eventForTimeOut = await db.event.findUnique({
      where: { id: signed.certificate.eventId },
    });
    if (eventForTimeOut?.enableTimeOut && eventForTimeOut.status === "active") {
      const timeOutWindows = getEventTimeWindows(eventForTimeOut);
      if (timeOutWindows.timeOut?.isLive) {
        // Time-out window is live — run the FULL anti-cheat pipeline before
        // recording the time-out. Previously this path only verified the
        // Ed25519 signature + timestamp, skipping token HMAC, event match,
        // and sub-frame liveness. That let a student with a registered
        // device fake a time-out with any garbage token. Now we verify the
        // same 10-step pipeline as a check-in scan.
        const sigResult = await verifySignedCertificate(signed);
        if (!sigResult.ok) {
          return badRequest(
            sigResult.reason === "device_not_registered"
              ? "This device is not registered. Please refresh and try again."
              : "Scan certificate signature verification failed.",
            "INVALID_CERTIFICATE",
          );
        }
        const tsResult = validateCertificateTimestamp(signed.certificate);
        if (!tsResult.ok) {
          return badRequest(
            tsResult.reason === "scanned_in_future"
              ? "Your device clock is too far ahead. Please sync your time settings."
              : "This scan is too old. Please scan again.",
            tsResult.reason,
          );
        }

        // Step 6: validate the token HMAC against scannedAt (offline-first).
        const timeOutTokenValidation = validateQrPayload(
          signed.certificate.token,
          eventForTimeOut.eventSecret,
          signed.certificate.scannedAt,
        );
        if (!timeOutTokenValidation.ok) {
          return NextResponse.json(
            {
              error: `Scan rejected: ${timeOutTokenValidation.reason}`,
              code: timeOutTokenValidation.reason,
            },
            { status: 400 },
          );
        }

        // Step 7: validate event match (certificate eventId = token eventId).
        if (timeOutTokenValidation.eventId !== signed.certificate.eventId) {
          return badRequest(
            "This token does not match the event",
            "EVENT_MISMATCH",
          );
        }
        const timeOutEventMatch = validateCertificateEventMatch(
          signed.certificate,
          timeOutTokenValidation.eventId,
        );
        if (!timeOutEventMatch.ok) {
          return badRequest("Certificate event mismatch", "EVENT_MISMATCH");
        }

        // Step 8: multi-frame liveness (sub-frame proof).
        if (
          timeOutTokenValidation.format === "v8" &&
          timeOutTokenValidation.timeBlock !== undefined
        ) {
          if (signed.certificate.subFrames.length < MIN_SUB_FRAMES) {
            return badRequest(
              `Scan rejected: insufficient frames captured. Hold the camera steady for at least 2 seconds.`,
              "insufficient_subframes",
            );
          }
          const liveness = verifySubFrameLiveness(
            signed.certificate.subFrames,
            eventForTimeOut.eventSecret,
            signed.certificate.eventId,
            timeOutTokenValidation.timeBlock,
          );
          if (!liveness.ok) {
            return badRequest(
              `Scan rejected: ${liveness.reason}. Please scan again — hold the camera steady for 2 seconds.`,
              liveness.reason,
            );
          }
        }

        // Offline grace: the scan must be synced within 15 minutes.
        const timeOutScanAgeMs =
          Date.now() - new Date(signed.certificate.scannedAt).getTime();
        const MAX_OFFLINE_GRACE_MS = 15 * 60 * 1000;
        if (timeOutScanAgeMs > MAX_OFFLINE_GRACE_MS) {
          return forbidden(
            "This scan is too old. Offline scans must be synced within 15 minutes.",
          );
        }

        // All checks passed — record the time-out using scannedAt (offline-first).
        const updated = await db.eventAttendance.update({
          where: { id: existing.id },
          data: { timeOutAt: new Date(signed.certificate.scannedAt) },
        });

        await audit({
          actorId: account.id,
          action: "attendance.timeout",
          targetType: "EventAttendance",
          targetId: updated.id,
          metadata: {
            eventId: signed.certificate.eventId,
            deviceFingerprint: signed.certificate.deviceFingerprint,
          },
          req,
        });

        return NextResponse.json({
          ok: true,
          action: "time_out",
          timeOutAt: updated.timeOutAt,
          message:
            "Time-out recorded. You're marked as checked out for this event.",
        });
      }
    }

    // Time-out not enabled or not live — return "already scanned."
    return NextResponse.json({
      ok: true,
      alreadyPresent: true,
      action: "already_scanned",
      scannedAt: existing.scannedAt,
      message:
        "This QR was already scanned. You are already marked present for this event.",
    });
  }

  // ---- Fetch the event BEFORE expensive crypto (fail fast on 404) ----
  // Moving this before verifySignedCertificate saves an Ed25519 verify +
  // device key DB lookup when the event doesn't exist or is inactive.
  const event = await db.event.findUnique({
    where: { id: signed.certificate.eventId },
  });
  if (!event) return notFound("Event not found");
  if (event.status !== "active")
    return forbidden("This event is no longer active");

  // ---- Verify the Ed25519 signature ----
  const sigResult = await verifySignedCertificate(signed);
  if (!sigResult.ok) {
    return badRequest(
      sigResult.reason === "device_not_registered"
        ? "This device is not registered. Please refresh and try again."
        : sigResult.reason === "device_revoked"
          ? "This device has been revoked. Contact an administrator."
          : "Scan certificate signature verification failed. The scan may have been tampered with.",
      "INVALID_CERTIFICATE",
    );
  }

  // ---- Validate the certificate timestamp ----
  const tsResult = validateCertificateTimestamp(signed.certificate);
  if (!tsResult.ok) {
    return badRequest(
      tsResult.reason === "scanned_in_future"
        ? "Your device clock is too far ahead. Please sync your clock and try again."
        : "This scan is too old to be accepted. Please scan again.",
      tsResult.reason?.toUpperCase(),
    );
  }

  // ---- Validate the token HMAC (against the certificate's scannedAt) ----
  // This is the KEY to offline resilience: we validate against the time
  // the scan was MADE, not the time it arrived at the server.
  const tokenValidation = validateQrPayload(
    signed.certificate.token,
    event.eventSecret,
    signed.certificate.scannedAt,
  );
  if (!tokenValidation.ok) {
    return NextResponse.json(
      {
        error: `Scan rejected: ${tokenValidation.reason}`,
        code: tokenValidation.reason,
      },
      { status: 400 },
    );
  }

  // ---- Validate event match (certificate eventId = token eventId) ----
  if (tokenValidation.eventId !== signed.certificate.eventId) {
    return badRequest("This token does not match the event", "EVENT_MISMATCH");
  }
  const eventMatch = validateCertificateEventMatch(
    signed.certificate,
    tokenValidation.eventId,
  );
  if (!eventMatch.ok) {
    return badRequest("Certificate event mismatch", "EVENT_MISMATCH");
  }

  // ---- Tier 2: Multi-frame liveness ----
  // The certificate must include at least MIN_SUB_FRAMES consecutive
  // sub-frames WITH their client-observed HMACs. The server verifies
  // each client-supplied HMAC against the server-recomputed value.
  // This proves the scanner watched the QR change over time — a single
  // photo captures only 1 sub-frame (1 HMAC), which is < MIN_SUB_FRAMES.
  if (
    tokenValidation.format === "v8" &&
    tokenValidation.timeBlock !== undefined
  ) {
    if (signed.certificate.subFrames.length < MIN_SUB_FRAMES) {
      return badRequest(
        `Scan rejected: insufficient frames captured. Hold the camera steady for at least 2 seconds.`,
        "insufficient_subframes",
      );
    }

    // Pass the CLIENT-SUPPLIED HMACs to verifySubFrameLiveness.
    // The function recomputes the expected HMAC for each sub-frame index
    // and compares it against the client-supplied value. If they don't
    // match, the sub-frame was fabricated (not actually captured).
    const liveness = verifySubFrameLiveness(
      signed.certificate.subFrames,
      event.eventSecret,
      signed.certificate.eventId,
      tokenValidation.timeBlock,
    );
    if (!liveness.ok) {
      return badRequest(
        `Scan rejected: ${liveness.reason}. Please scan again — hold the camera steady for 2 seconds.`,
        liveness.reason,
      );
    }
  }

  // ---- Anti-cheating: time window validation ----
  // For offline scans, use the certificate's scannedAt timestamp (when the
  // student actually scanned) instead of Date.now() (when the server
  // processes it). This allows offline scans to be synced after the window
  // closes. Grace period: 15 minutes max — enough for "scan in a dead zone,
  // walk to WiFi, sync" but not enough for photo-replay attacks.
  const certScannedAt = new Date(signed.certificate.scannedAt);
  const now = Date.now();
  const scanAgeMs = now - certScannedAt.getTime();
  const MAX_OFFLINE_GRACE_MS = 15 * 60 * 1000; // 15 minutes
  if (scanAgeMs > MAX_OFFLINE_GRACE_MS) {
    return forbidden(
      "This scan is too old. Offline scans must be synced within 15 minutes.",
    );
  }

  // Check the time window using the scannedAt timestamp (not server time).
  const windows = getEventTimeWindows(event);
  const scanTime = certScannedAt.getTime();
  const opensAt = windows.checkIn.opensAt.getTime();
  const closesAt = windows.checkIn.closesAt.getTime();

  if (scanTime < opensAt) {
    return forbidden("This event hadn't opened for check-in when you scanned.");
  }
  if (scanTime > closesAt) {
    return forbidden(
      "This event's check-in window had closed when you scanned.",
    );
  }

  // ---- Event eligibility (strict — mirrors GET /api/events visibility) ----
  // A student is eligible to check in if and only if:
  //   1. OPEN TO ALL — both targetProgram AND targetSection are null, OR
  //   2. EXACT MATCH — targetProgram = student's program AND
  //      targetSection = student's section.
  //
  // This is the SAME rule used by the events list endpoint. A student
  // who can SEE the event in their list can SCAN it. A student who
  // CANNOT see it (e.g. different program, or program-wide event they're
  // not targeted to) CANNOT scan it.
  //
  // Examples:
  //   Event: open-to-all → ALL students eligible
  //   Event: BSIT + 1-A → only BSIT/1-A students eligible
  //   Event: BSIT + null (program-wide) → NO students eligible
  //     (program-wide events are hidden from students per strict rule)
  const isOpenToAll = !event.targetProgram && !event.targetSection;
  const isExactMatch =
    !!event.targetProgram &&
    !!event.targetSection &&
    event.targetProgram === account.program &&
    event.targetSection === account.section;
  if (!isOpenToAll && !isExactMatch) {
    return forbidden(
      "You are not eligible for this event. Your course and section must match the event's target.",
    );
  }

  // ---- Derive the idempotency key (deterministic, tamper-proof) ----
  // Stored for audit/replay detection, but NOT pre-checked via a separate
  // SELECT. The unique constraint on (eventId, accountId) already catches
  // duplicates atomically at the insert below. Removing the pre-check
  // saves 1 DB round-trip per scan (the most common hot-path optimization).
  const idempotencyKey = deriveIdempotencyKey(signed.certificate);

  // ---- ATOMIC ONE-ATTEMPT INSERT ----
  // The unique constraint on (eventId, accountId) guarantees that even
  // if two concurrent requests race, only ONE will succeed. The other
  // gets a P2002 error, caught below.
  try {
    const attendance = await db.eventAttendance.create({
      data: {
        eventId: signed.certificate.eventId,
        accountId: account.id,
        source: "qr",
        idempotencyKey,
        tokenBlock: tokenValidation.timeBlock,
        certificateNonce: signed.certificate.nonce,
        certificateSubFrames: JSON.stringify(
          signed.certificate.subFrames.map((s) => ({ subFrame: s.subFrame })),
        ),
        deviceFingerprint: signed.certificate.deviceFingerprint,
        scannedAtClient: new Date(signed.certificate.scannedAt),
      },
      include: {
        account: {
          select: {
            id: true,
            fullName: true,
            studentId: true,
            program: true,
            section: true,
          },
        },
      },
    });

    // ---- Realtime notification ----
    notifyAttendance(signed.certificate.eventId, {
      id: attendance.id,
      accountId: attendance.account.id,
      fullName: attendance.account.fullName,
      studentId: attendance.account.studentId,
      program: attendance.account.program,
      section: attendance.account.section,
      scannedAt: attendance.scannedAt.toISOString(),
      source: "qr",
    }).catch(() => {});

    // ---- Audit log (fire-and-forget: don't block the response) ----
    // The audit write is non-critical (append-only log). Firing it without
    // await lets the response return immediately while the write completes
    // in the background. The audit() function has its own try/catch so a
    // failure won't crash the serverless instance.
    audit({
      actorId: account.id,
      action: "attendance.timein",
      targetType: "EventAttendance",
      targetId: attendance.id,
      metadata: {
        eventId: signed.certificate.eventId,
        tokenBlock: tokenValidation.timeBlock,
        deviceFingerprint: signed.certificate.deviceFingerprint,
        subFrames: signed.certificate.subFrames,
        driftMs: tsResult.driftMs,
      },
      req,
    }).catch(() => {});

    return NextResponse.json(
      {
        ok: true,
        action: "time_in",
        attendance,
        message: "Time-in recorded. You're marked present for this event.",
      },
      { status: 201 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // P2002 = unique constraint violation (race condition or duplicate)
    if (msg.includes("Unique constraint")) {
      return NextResponse.json({
        ok: true,
        alreadyPresent: true,
        action: "already_scanned",
        message:
          "This QR was already scanned. You are already marked present for this event.",
      });
    }
    throw e;
  }
}
