import { PrismaClient, Prisma } from "@/generated/prisma/client";
import { createAdapterFromUrl } from "@/lib/db-adapter";

// ====================================================================
// DATABASE PROVIDER (Prisma 7 - driver adapters)
// --------------------------------------------------------------------
// Production: TiDB Serverless (MySQL-compatible). Local dev: SQLite.
// Supabase is used for AUTH ONLY (sessions/JWT/email) — app data lives in
// TiDB. See docs/tidb-data-protection.md for the full data-protection ADR.
//
// PRISMA 7 MIGRATION NOTES:
// Prisma 7 removed the Rust query engine and the schema-level
// `datasource url`. Connections are established through DRIVER ADAPTERS
// (see src/lib/db-adapter.ts) passed to the PrismaClient constructor:
//   - mysql://...        -> @prisma/adapter-mariadb     (TiDB prod)
//   - file:...           -> @prisma/adapter-better-sqlite3 (local dev)
// The old `datasources: { db: { url } }` constructor option no longer
// exists; per-client URLs are set by building the adapter from a URL.
// Schema/connection CONFIG files: prisma.config.ts (sqlite),
// prisma.tidb.config.ts, prisma.postgres.config.ts.
//
// CRITICAL — TiDB has NO built-in Row-Level Security (unlike Postgres).
// Row scoping is enforced in the APPLICATION LAYER:
//   - Read paths use centralized predicates (src/lib/event-visibility.ts).
//   - Every [id] route re-authorizes against the caller (BOLA defense).
//   - Organizers are program-scoped in events/route.ts + export route.
// A single missed `where` clause is a data leak. When adding a query,
// import the shared predicate instead of hand-rolling the `where`.
// ====================================================================

// Only log queries in development - in production, query logging
// adds significant overhead (every query is serialized and printed).
const logConfig = process.env.NODE_ENV === "production" ? [] : ["query"];

// Cache-busting key. Bump this when the Prisma schema or client
// generation changes and `bun run db:generate` has been run, so the dev
// server's `globalThis.prisma` cache (which holds the OLD generated
// client) is invalidated and a fresh PrismaClient is created. Without
// this, schema changes don't take effect until the dev server is
// manually restarted.
const SCHEMA_CACHE_KEY = "v19-prisma7-driver-adapters";

const globalWithKey = globalThis as unknown as {
  __prismaCacheKey?: string;
  prisma?: PrismaClient;
  prismaRead?: PrismaClient;
};

/**
 * Builds a PrismaClient wired to a driver adapter for the given URL.
 * The URL -> adapter conversion itself lives in src/lib/db-adapter.ts
 * (shared with scripts/migrate-to-tidb.ts).
 */
function createPrismaClient(url: string): PrismaClient {
  return new PrismaClient({
    adapter: createAdapterFromUrl(url),
    log: logConfig as Prisma.LogLevel[],
  });
}

// If the cache key doesn't match (or there's no cached client),
// create a fresh one and stamp the new key.
//
// SERVERLESS CONNECTION POOLING (300-concurrent target on TiDB Serverless):
// The per-instance pool size is controlled by the `connection_limit` query
// param in DATABASE_URL and mapped onto the mariadb adapter's
// `connectionLimit` in createAdapterFromUrl. The encode-tidb-url helper and
// example.env both append `connection_limit=5&pool_timeout=10`. With
// ~60-100 warm Vercel instances that yields 300-500 total connections,
// under TiDB Serverless's 1000-conn cluster cap. We keep ONE PrismaClient
// per instance via the globalThis singleton below so HMR (dev) and warm
// instances (prod) don't leak connections - the historical serverless
// connection-exhaustion bug.
const DATABASE_URL = process.env.DATABASE_URL ?? "";

if (
  globalWithKey.prisma &&
  globalWithKey.__prismaCacheKey === SCHEMA_CACHE_KEY
) {
  // Cache hit - reuse the existing client.
} else if (DATABASE_URL) {
  globalWithKey.prisma = createPrismaClient(DATABASE_URL);
  globalWithKey.__prismaCacheKey = SCHEMA_CACHE_KEY;
} else {
  // Fail loudly and early with the fix, instead of a deep adapter error
  // on the first query.
  throw new Error(
    "[db] DATABASE_URL is not set.\n" +
      "  Local dev: copy example.env to .env (DATABASE_URL=file:./db/custom.db).\n" +
      "  Production: set DATABASE_URL to the TiDB (mysql://) connection string.",
  );
}

export const db = globalWithKey.prisma!;

// ---- Optional read replica (for dashboard/stats heavy reads) ----
// If DATABASE_REPLICA_URL is set, routes read-heavy queries through a
// separate PrismaClient connected to the replica. Falls back to the
// primary db if not configured. Prisma 7 has no per-client datasource
// override - the replica URL is wrapped in its own driver adapter, so
// it must be a mysql:// (TiDB) URL. Legacy postgres:// replica URLs are
// ignored with a warning (Supabase is auth-only since the TiDB cutover).
const REPLICA_URL = process.env.DATABASE_REPLICA_URL;
if (REPLICA_URL && !globalWithKey.prismaRead) {
  if (REPLICA_URL.startsWith("mysql")) {
    globalWithKey.prismaRead = createPrismaClient(REPLICA_URL);
  } else {
    console.warn(
      "[db] DATABASE_REPLICA_URL is set but is not a mysql:// URL - " +
        "Prisma 7 driver adapters support mysql:// or file: only. " +
        "Falling back to the primary database for replica reads.",
    );
  }
}
// Export dbRead: the replica client if configured, else the primary db.
export const dbRead = globalWithKey.prismaRead ?? db;
