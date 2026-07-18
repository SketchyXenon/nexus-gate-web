import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Only log queries in development — in production, query logging
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
if (
  globalWithKey.prisma &&
  globalWithKey.__prismaCacheKey === SCHEMA_CACHE_KEY
) {
  // Cache hit — reuse the existing client.
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
