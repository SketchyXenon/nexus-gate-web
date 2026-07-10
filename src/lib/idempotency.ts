// ====================================================================
// Nexus Gate — Idempotency Store
// Prevents duplicate mutations when the offline sync queue retries.
// Keyed by a client-generated UUID. The TTL is intentionally short (1h)
// to match the 15-min sync window — a scan that syncs after 15 min is
// already rejected by validateCertificateTimestamp, so keeping the
// idempotency record longer is unnecessary.
// ====================================================================

import { db } from "@/lib/db";

const TTL_HOURS = 1;

/**
 * Find an existing attendance record by idempotency key.
 * Returns null if not found.
 */
export async function findIdempotentAttendance(key: string) {
  return db.eventAttendance.findUnique({
    where: { idempotencyKey: key },
  });
}

export { TTL_HOURS as IDEMPOTENCY_TTL_HOURS };
