// ====================================================================
// Nexus Gate - Prisma 7 driver adapter factory
// --------------------------------------------------------------------
// Prisma 7 removed the Rust query engine and the schema-level
// `datasource url`. Every PrismaClient connects through a DRIVER
// ADAPTER built from a connection URL. This module centralizes that
// URL -> adapter conversion so both the app (src/lib/db.ts) and the
// maintenance scripts (scripts/migrate-to-tidb.ts) resolve
// connections IDENTICALLY.
//
// Supported protocols (keep in sync with scripts/postinstall.mjs and
// src/lib/db-provider.ts):
//   - mysql://...  -> @prisma/adapter-mariadb        (TiDB prod)
//   - file:...     -> Node: @prisma/adapter-better-sqlite3
//                     Bun:   prisma-adapter-bun-sqlite
//
// WHY TWO SQLITE ADAPTERS: better-sqlite3 is a NAPI native module and
// is NOT loadable under the Bun runtime (oven-sh/bun#4290), while the
// app itself always runs under Node (next dev / Vercel). Bun-run
// maintenance scripts (bootstrap-admin, seed-events, ...) that touch
// the local SQLite dev database therefore need the bun:sqlite-based
// adapter instead. The Bun branch is guarded by a runtime check and
// the module is loaded lazily inside connect() (see lazyBunSqliteFactory).
// ====================================================================
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import type { SqlDriverAdapter, SqlDriverAdapterFactory } from "@prisma/driver-adapter-utils";

// Every Prisma 7 adapter implements SqlDriverAdapterFactory, which is
// exactly what the PrismaClient constructor's `adapter` prop expects.
export type PrismaDriverAdapter = SqlDriverAdapterFactory;

// Runtime detection without importing bun-types into the Node type
// graph: property probing on globalThis keeps tsc (which may run
// without bun-types) happy.
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

// Memoized module handle for the bun:sqlite adapter (loaded at most
// once per process, and only from inside connect() under Bun).
let bunSqliteFactoryPromise: Promise<{ connect(): Promise<SqlDriverAdapter> }> | null = null;

/**
 * Returns a SYNCHRONOUS factory object for the bun:sqlite adapter whose
 * actual module is imported lazily inside connect(). This keeps the
 * `import("prisma-adapter-bun-sqlite")` boundary async (the package's
 * exports map is import-only, so require() cannot load it) while the
 * PrismaClient constructor - which needs a factory object immediately -
 * stays synchronous. The package is listed in next.config.ts
 * serverExternalPackages so the Node server build externalizes it
 * instead of trying to bundle `bun:sqlite`.
 */
function lazyBunSqliteFactory(url: string): SqlDriverAdapterFactory {
  const factory: SqlDriverAdapterFactory = {
    provider: "sqlite",
    adapterName: "prisma-adapter-bun-sqlite (lazy)",
    connect: async () => {
      if (!bunSqliteFactoryPromise) {
        bunSqliteFactoryPromise = import("prisma-adapter-bun-sqlite").then(
          (m) => new m.PrismaBunSqlite({ url }),
        );
      }
      const inner = await bunSqliteFactoryPromise;
      return inner.connect();
    },
  };
  return factory;
}

/**
 * Builds a Prisma 7 driver adapter from a connection URL.
 */
export function createAdapterFromUrl(rawUrl: string): PrismaDriverAdapter {
  const url = rawUrl.trim();

  // ---- MySQL / TiDB Serverless --------------------------------------
  if (url.startsWith("mysql")) {
    const u = new URL(url);
    const params = u.searchParams;

    // Prisma URL params -> mariadb pool config:
    //   connection_limit=N -> connectionLimit (default 5, matches the
    //     300-concurrent TiDB Serverless sizing in example.env)
    //   pool_timeout=S     -> acquireTimeout (mariadb takes milliseconds)
    const connectionLimit = Number.parseInt(params.get("connection_limit") ?? "", 10);
    const poolTimeout = Number.parseInt(params.get("pool_timeout") ?? "", 10);

    // TLS: TiDB Serverless REQUIRES encrypted connections. Honor the
    // classic Prisma sslaccept values, a plain ssl=true/false, and
    // auto-enable strict TLS for *.tidbcloud.com hosts even when the
    // URL carries no ssl params (the common TiDB Cloud Serverless URL).
    const sslAccept = params.get("sslaccept");
    const sslParam = params.get("ssl");
    const isTiDBCloud = u.hostname.endsWith("tidbcloud.com");
    let ssl: { rejectUnauthorized: boolean } | undefined;
    if (sslAccept === "accept_invalid_certs" || sslParam === "false") {
      ssl = { rejectUnauthorized: false };
    } else if (sslAccept === "strict" || sslParam === "true" || sslAccept || isTiDBCloud) {
      ssl = { rejectUnauthorized: true };
    }

    return new PrismaMariaDb({
      host: u.hostname,
      port: u.port ? Number(u.port) : 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, "") || undefined,
      connectionLimit: Number.isFinite(connectionLimit) ? connectionLimit : 5,
      ...(Number.isFinite(poolTimeout) ? { acquireTimeout: poolTimeout * 1000 } : {}),
      ...(ssl ? { ssl } : {}),
    });
  }

  // ---- SQLite (local dev) -------------------------------------------
  if (url.startsWith("file:")) {
    // Strip query params (connection_limit etc. are meaningless for the
    // SQLite drivers) and percent-decode the path. Relative paths are
    // resolved against the process CWD (project root for next dev, bun
    // scripts, and next build alike).
    let path = url.slice("file:".length).split("?")[0];
    try {
      path = decodeURIComponent(path);
    } catch {
      // keep the raw path if it is not valid percent-encoding
    }
    if (isBunRuntime) {
      // Bun cannot load better-sqlite3 (NAPI) - use bun:sqlite instead.
      return lazyBunSqliteFactory(path);
    }
    return new PrismaBetterSqlite3({ url: path });
  }

  throw new Error(
    `[db-adapter] Unsupported connection URL protocol: "${url.slice(0, 24)}...".\n` +
      "  Supported: mysql:// (TiDB prod) and file: (SQLite dev).\n" +
      "  Legacy postgres:// app-data URLs are no longer supported at " +
      "runtime - production app data lives in TiDB (see docs/tidb-data-protection.md).",
  );
}
