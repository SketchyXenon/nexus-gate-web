// ====================================================================
// Nexus Gate — Idempotency Store
// Prevents duplicate mutations when the offline sync queue retries.
// Keyed by a client-generated UUID; cached results expire after 24h.
// ====================================================================

import { db } from "@/lib/db";

const TTL_HOURS = 24;

/**
 * Find an existing attendance record by idempotency key.
 * Returns null if not found.
 */
export async function findIdempotentAttendance(
  key: string
) {
  return db.eventAttendance.findUnique({
    where: { idempotencyKey: key },
  });
}

export { TTL_HOURS as IDEMPOTENCY_TTL_HOURS };
