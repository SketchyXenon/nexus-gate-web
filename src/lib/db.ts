import { PrismaClient } from "@prisma/client";

// ====================================================================
// DATABASE PROVIDER
// --------------------------------------------------------------------
// Production: TiDB Serverless (MySQL-compatible). Local dev: SQLite.
// Supabase is used for AUTH ONLY (sessions/JWT/email) — app data lives in
// TiDB. See docs/tidb-data-protection.md for the full data-protection ADR.
//
// CRITICAL — TiDB has NO built-in Row-Level Security (unlike Postgres).
// Row scoping is enforced in the APPLICATION LAYER:
//   - Read paths use centralized predicates (src/lib/event-visibility.ts).
//   - Every [id] route re-authorizes against the caller (BOLA defense).
//   - Organizers are program-scoped in events/route.ts + export route.
// A single missed `where` clause is a data leak. When adding a query,
// import the shared predicate instead of hand-rolling the `where`.
// ====================================================================

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Only log queries in development - in production, query logging
// adds significant overhead (every query is serialized and printed).
const logConfig = process.env.NODE_ENV === "production" ? [] : ["query"];

// Cache-busting key. Bump this when the Prisma schema changes and
// `bun run db:generate` has been run, so the dev server's
// `globalThis.prisma` cache (which holds the OLD generated client)
// is invalidated and a fresh PrismaClient is created. Without this,
// schema changes don't take effect until the dev server is manually
// restarted.
const SCHEMA_CACHE_KEY = "v16-terms-acceptance-2026-07-18";

const globalWithKey = globalThis as unknown as {
  __prismaCacheKey?: string;
  prisma?: PrismaClient;
  prismaRead?: PrismaClient;
};

// If the cache key doesn't match (or there's no cached client),
// create a fresh one and stamp the new key.
//
// SERVERLESS CONNECTION POOLING (300-concurrent target on TiDB Serverless):
// The per-instance pool size is controlled by the `connection_limit` query
// param in DATABASE_URL (NOT here) - Prisma's MySQL connector reads it from
// the URL. The encode-tidb-url helper and example.env both append
// `connection_limit=5&pool_timeout=10`. With ~60-100 warm Vercel instances
// that yields 300-500 total connections, under TiDB Serverless's 1000-conn
// cluster cap. We keep ONE PrismaClient per instance via the globalThis
// singleton below so HMR (dev) and warm instances (prod) don't leak
// connections - the historical serverless connection-exhaustion bug.
if (
  globalWithKey.prisma &&
  globalWithKey.__prismaCacheKey === SCHEMA_CACHE_KEY
) {
  // Cache hit - reuse the existing client.
} else {
  globalWithKey.prisma = new PrismaClient({ log: logConfig as any });
  globalWithKey.__prismaCacheKey = SCHEMA_CACHE_KEY;
}

export const db = globalWithKey.prisma!;

// ---- Optional read replica (for dashboard/stats heavy reads) ----
// If DATABASE_REPLICA_URL is set, routes read-heavy queries through a
// separate PrismaClient connected to the replica. Falls back to the
// primary db if not configured. Set DATABASE_REPLICA_URL in your env
// to a Supabase read replica connection string to enable.
const REPLICA_URL = process.env.DATABASE_REPLICA_URL;
if (REPLICA_URL && !globalWithKey.prismaRead) {
  globalWithKey.prismaRead = new PrismaClient({
    log: logConfig as any,
    datasources: { db: { url: REPLICA_URL } },
  });
}
// Export dbRead: the replica client if configured, else the primary db.
export const dbRead = globalWithKey.prismaRead ?? db;
