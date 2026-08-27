import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, dbUnavailable, isDbUnavailableError } from "@/lib/api";
import {
  getDatabaseProvider,
  getMaskedDatabaseTarget,
  datasourceEnvMismatch,
  type DbProvider,
} from "@/lib/db-provider";

// ====================================================================
// GET /api/admin/db-health (ADMIN only)
// --------------------------------------------------------------------
// Makes the DEPLOYED application report which database it is actually
// connected to, and which physical columns exist there RIGHT NOW.
//
// WHY THIS EXISTS: `bun run db:verify:tidb` compares the LOCAL url's
// database against the local schema. It can say IN SYNC while
// production still returns DB_SCHEMA_DRIFT - which means the local url
// and the DEPLOYED app's url point at different databases (different
// TiDB cluster, different database name in the url path, or a stale
// TIDB_DATABASE_URL/DATABASE_URL on Vercel). This endpoint removes the
// guesswork: it shows the app's masked datasource identity (host /
// database / user - NEVER the password or query params) plus the live
// column set of the attendance_overrides table, compared against the
// columns the CURRENT schema expects.
//
// SECURITY:
//  - ADMIN only (organizers/students get 403, anonymous 401).
//  - The datasource identity is MASKED: no password, no query params.
//  - No user-supplied input reaches the SQL (identifiers are literals
//    from this file, not from the request).
// ====================================================================

// Physical column names of AttendanceOverride per the CURRENT Prisma
// schemas (v16). MySQL/Postgres schemas use @map snake_case names;
// the SQLite dev schema has no @map so columns are the field names.
// KEEP IN SYNC with prisma/schema.*.prisma when the model changes -
// this table is the drift smoke-test.
const EXPECTED_COLUMNS: Record<DbProvider, readonly string[]> = {
  mysql: [
    "id",
    "event_id",
    "admin_id",
    "student_id",
    "reason",
    "created_at",
    "client_created_at",
    "device_fingerprint",
    "sync_delay_ms",
    "clock_drift_ms",
    "offline",
  ],
  postgresql: [
    "id",
    "event_id",
    "admin_id",
    "student_id",
    "reason",
    "created_at",
    "client_created_at",
    "device_fingerprint",
    "sync_delay_ms",
    "clock_drift_ms",
    "offline",
  ],
  sqlite: [
    "id",
    "eventId",
    "creatorId",
    "studentId",
    "reason",
    "createdAt",
    "clientCreatedAt",
    "deviceFingerprint",
    "syncDelayMs",
    "clockDriftMs",
    "offline",
  ],
};

const TABLE_NAME: Record<DbProvider, string> = {
  mysql: "attendance_overrides",
  postgresql: "attendance_overrides",
  sqlite: "AttendanceOverride",
};

interface ColumnRow {
  COLUMN_NAME?: unknown;
  column_name?: unknown;
  name?: unknown;
}
interface ServerInfoRow {
  schema_name?: unknown;
  database?: unknown;
  version?: unknown;
}

function firstString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export async function GET() {
  const res = await requireAuth("ADMIN");
  if ("error" in res) return res.error;

  const provider = getDatabaseProvider();
  const table = TABLE_NAME[provider];
  const expected = EXPECTED_COLUMNS[provider];
  const target = getMaskedDatabaseTarget();

  try {
    let columns: string[] = [];
    let serverDatabase: string | null = null;
    let serverVersion: string | null = null;

    if (provider === "sqlite") {
      // SQLite: table-valued pragma functions work as plain SELECTs.
      const colRows = (await db.$queryRawUnsafe(
        `SELECT name FROM pragma_table_info('${table}')`,
      )) as ColumnRow[];
      columns = colRows
        .map((r) => firstString(r.name))
        .filter((c): c is string => !!c);
      const info = (await db.$queryRawUnsafe(
        "SELECT sqlite_version() AS version",
      )) as ServerInfoRow[];
      serverVersion = firstString(info[0]?.version);
      serverDatabase = target.database; // file path from the url
    } else if (provider === "mysql") {
      // TiDB / MySQL: information_schema scoped to the CURRENT database.
      const colRows = (await db.$queryRawUnsafe(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS ` +
          `WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`,
      )) as ColumnRow[];
      columns = colRows
        .map((r) => firstString(r.COLUMN_NAME))
        .filter((c): c is string => !!c);
      const info = (await db.$queryRawUnsafe(
        "SELECT DATABASE() AS schema_name, VERSION() AS version",
      )) as ServerInfoRow[];
      serverDatabase = firstString(info[0]?.schema_name);
      serverVersion = firstString(info[0]?.version);
    } else {
      // PostgreSQL.
      const colRows = (await db.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns ` +
          `WHERE table_schema = current_schema() AND table_name = '${table}'`,
      )) as ColumnRow[];
      columns = colRows
        .map((r) => firstString(r.column_name))
        .filter((c): c is string => !!c);
      const info = (await db.$queryRawUnsafe(
        "SELECT current_database() AS schema_name, version() AS version",
      )) as ServerInfoRow[];
      serverDatabase = firstString(info[0]?.schema_name);
      serverVersion = firstString(info[0]?.version);
    }

    const sorted = [...columns].sort();
    const missing = expected.filter((c) => !columns.includes(c));
    const extra = sorted.filter((c) => !expected.includes(c));
    const tableExists = columns.length > 0;
    const verdict = !tableExists || missing.length > 0 ? "DRIFT" : "OK";

    return NextResponse.json(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        provider,
        // Masked identity of the datasource THIS instance resolves.
        // Compare host/database against what you pushed/verified
        // locally - a difference here IS the root cause of
        // "verify says IN SYNC but production still drifts".
        datasource: {
          resolvedFrom: target.source,
          user: target.user,
          host: target.host,
          port: target.port,
          database: target.database,
          envWarning: datasourceEnvMismatch()
            ? "TIDB_DATABASE_URL and DATABASE_URL are both set but DIFFER. " +
              "The MySQL client uses TIDB_DATABASE_URL at runtime - align " +
              "them in Vercel -> Settings -> Environment Variables."
            : null,
        },
        server: {
          // What the DATABASE itself says it is (SELECT DATABASE() /
          // current_database()); null on SQLite (no such function).
          database: serverDatabase,
          version: serverVersion,
        },
        table,
        tableExists,
        columns: sorted,
        expectedColumns: [...expected].sort(),
        missingColumns: missing,
        extraColumns: extra,
        verdict,
        hint:
          verdict === "DRIFT"
            ? missing.length > 0
              ? "The database this app is connected to is missing columns the " +
                "deployed code expects. Either push the CURRENT schema to THIS " +
                "database, or fix the env var so the app points at the database " +
                "you already pushed. Locally run `bun run db:diagnose:tidb` to " +
                "check every configured MySQL url."
              : "The table does not exist in the connected database."
            : null,
      },
      { status: 200 },
    );
  } catch (e) {
    if (isDbUnavailableError(e)) return dbUnavailable(e);
    console.error("[admin/db-health] introspection failed:", e);
    return dbUnavailable(e);
  }
}
