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

/**
 * Returns true when the thrown value is a Prisma SCHEMA DRIFT error:
 *   P2021 - the table referenced by the query does not exist in the DB
 *   P2022 - a column referenced by the query does not exist in the DB
 *
 * This is the "deployed code is newer than the pushed schema" failure:
 * the Prisma client was generated from the current schema (which has the
 * column), but the live database was pushed from an older schema and
 * never got the ALTER TABLE. Classic trigger: running `db:push:tidb`
 * from a stale local checkout after deploying current code.
 *
 * isDbUnavailableError (api.ts) deliberately does NOT catch these - they
 * are request-shaped errors, not connection failures - so without this
 * helper they surface as opaque 500s. Callers should return the
 * dbSchemaDrift() response (503 + DB_SCHEMA_DRIFT) instead, which makes
 * the failure self-diagnosing in production.
 */
export function isSchemaDriftError(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.code === "P2021" || e.code === "P2022")
  );
}
