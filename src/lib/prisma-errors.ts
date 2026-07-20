// Nexus Gate - Prisma error classification helpers.
//
// Replaces the fragile `e.message.includes("Unique constraint")` pattern
// scattered across route handlers. Prisma exposes a stable `code` property
// on PrismaClientKnownRequestError (e.g. "P2002" for unique-constraint
// violations). Matching on the code is locale- and version-stable.

import { Prisma } from "@prisma/client";

/**
 * Returns true when the thrown value is a Prisma unique-constraint
 * violation (P2002). Used by scan, override, and register routes to
 * convert race-condition duplicates into the correct user-facing response
 * instead of a generic 500.
 */
export function isUniqueConstraintError(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
  );
}
