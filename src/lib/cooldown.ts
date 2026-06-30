// ====================================================================
// Nexus Gate — Cooldown calculation helpers (pure, unit-tested)
// ====================================================================
// These functions encapsulate the 30-day cooldown logic used by the
// profile update and password change routes. Keeping them pure makes
// them trivial to unit-test without a database.
// ====================================================================

export const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Determine whether a cooldown has expired.
 *
 * @param lastChangedAt - The timestamp of the last change (null = never changed)
 * @param now           - The current timestamp (injectable for testing)
 * @returns `true` if the cooldown has passed (or was never set), `false` otherwise.
 */
export function isCooldownExpired(lastChangedAt: Date | null, now: number = Date.now()): boolean {
  if (!lastChangedAt) return true;
  return now - lastChangedAt.getTime() >= COOLDOWN_MS;
}

/**
 * Calculate the number of days remaining until the cooldown expires.
 *
 * @param lastChangedAt - The timestamp of the last change (null = never changed)
 * @param now           - The current timestamp (injectable for testing)
 * @returns 0 if the cooldown has expired, otherwise the ceiling of days remaining.
 */
export function daysUntilCooldownExpires(lastChangedAt: Date | null, now: number = Date.now()): number {
  if (!lastChangedAt) return 0;
  const elapsed = now - lastChangedAt.getTime();
  if (elapsed >= COOLDOWN_MS) return 0;
  return Math.ceil((COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000));
}
