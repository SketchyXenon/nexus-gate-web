// Centralized database provider detection.
// Used to branch raw SQL / JSON handling across the three supported backends:
//   - PostgreSQL (Supabase prod)
//   - MySQL / TiDB (migration target)
//   - SQLite (local dev)
// Keeping this in one place avoids scattered DATABASE_URL string checks
// that can drift (e.g. branching on "postgresql" alone misclassifies TiDB).

export type DbProvider = "postgresql" | "mysql" | "sqlite";

export function getDatabaseProvider(): DbProvider {
  const url = process.env.DATABASE_URL ?? "";
  if (url.startsWith("postgresql")) return "postgresql";
  if (url.startsWith("mysql")) return "mysql";
  return "sqlite";
}

// SQLite stores notificationPrefs as a plain String? (no native JSON type);
// PostgreSQL and TiDB/MySQL declare it as Json? and accept an object.
// Use this to decide whether to JSON.stringify before writing.
export function storesJsonAsString(): boolean {
  return getDatabaseProvider() === "sqlite";
}

// ====================================================================
// RUNTIME DATASOURCE IDENTITY (diagnostics only)
// --------------------------------------------------------------------
// Answers "WHICH database is this running instance actually connected
// to?" - without ever exposing the password or query params.
//
// WHY: `bun run db:verify:tidb` can report IN SYNC while production
// still returns DB_SCHEMA_DRIFT. That combination means the database
// the LOCAL url points at is NOT the database the DEPLOYED app queries
// (different TiDB cluster, different database name in the URL path, or
// a stale env var on Vercel). These helpers make the deployed app's
// actual target visible (see /api/admin/db-health and the
// dbSchemaDrift() log line in src/lib/api.ts) so the mismatch can be
// spotted in seconds instead of guessed at.
// ====================================================================

export interface MaskedDbTarget {
  provider: DbProvider;
  /** Env var the generated Prisma client resolves its datasource from. */
  source: string;
  set: boolean;
  user: string | null;
  host: string | null;
  port: string | null;
  database: string | null;
}

function parseMasked(
  raw: string,
): Pick<MaskedDbTarget, "user" | "host" | "port" | "database"> {
  try {
    const u = new URL(raw);
    return {
      user: u.username || null,
      host: u.hostname || null,
      port: u.port || null,
      // For file: URLs the pathname IS the database file; strip leading
      // "./" noise. For SQL URLs the first path segment is the db name.
      database:
        u.protocol === "file:"
          ? u.pathname.replace(/^\.\//, "") || null
          : u.pathname.replace(/^\//, "") || null,
    };
  } catch {
    return { user: null, host: null, port: null, database: null };
  }
}

/**
 * Masked identity of the datasource THIS instance's Prisma client
 * resolves. Mirrors the runtime resolution rules:
 *  - MySQL/TiDB client (generated from schema.tidb.prisma) reads
 *    env("TIDB_DATABASE_URL"); scripts/postinstall.mjs maps
 *    DATABASE_URL into it only when it is absent.
 *  - SQLite/Postgres clients read env("DATABASE_URL").
 */
export function getMaskedDatabaseTarget(): MaskedDbTarget {
  const provider = getDatabaseProvider();
  const tidb = process.env.TIDB_DATABASE_URL;
  const main = process.env.DATABASE_URL;
  if (provider === "mysql") {
    const raw = tidb || main || "";
    return {
      provider,
      source: tidb ? "TIDB_DATABASE_URL" : "DATABASE_URL",
      set: Boolean(raw),
      ...parseMasked(raw),
    };
  }
  const raw = main || "";
  return {
    provider,
    source: "DATABASE_URL",
    set: Boolean(raw),
    ...parseMasked(raw),
  };
}

/**
 * True when BOTH TIDB_DATABASE_URL and DATABASE_URL are set but hold
 * DIFFERENT urls. On the MySQL client TIDB_DATABASE_URL wins at
 * runtime - if it differs from the DATABASE_URL the operator thinks
 * they deployed with, the app silently queries a different database
 * than expected (the classic "verify says IN SYNC, prod still
 * P2022" trap).
 */
export function datasourceEnvMismatch(): boolean {
  const tidb = process.env.TIDB_DATABASE_URL;
  const main = process.env.DATABASE_URL;
  return Boolean(tidb && main && tidb !== main);
}

/** One-line human rendering of a MaskedDbTarget for server logs. */
export function describeMaskedTarget(t: MaskedDbTarget): string {
  if (!t.set) return "(datasource env var unset)";
  const auth = t.user ? `${t.user}@` : "";
  const port = t.port ? `:${t.port}` : "";
  return `${t.source} -> ${auth}${t.host ?? "?"}${port}/${t.database ?? "?"} [${t.provider}]`;
}
