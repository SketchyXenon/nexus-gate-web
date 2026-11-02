// ====================================================================
// Prisma 7 configuration - Legacy Supabase Postgres
// --------------------------------------------------------------------
// Prisma 7 removed the datasource `url` from schema files. This config
// keeps the LEGACY PostgreSQL path (prisma/schema.prisma) usable - e.g.
// the pre-TiDB Supabase deployment or the source side of the one-time
// data migration (scripts/migrate-to-tidb.ts).
//
// The current production database is TiDB (prisma.tidb.config.ts);
// Supabase remains auth-only. See docs/tidb-data-protection.md.
// ====================================================================
import { defineConfig } from "prisma/config";
import { loadProjectEnv } from "./prisma/load-env";

// Prisma 7 dropped automatic .env loading - do it here, explicitly.
loadProjectEnv();

// Trim + treat "" as unset. A postgres:// / postgresql:// DATABASE_URL
// wins; anything else (e.g. the SQLite file: URL used for local dev)
// falls through to SOURCE_DATABASE_URL so a migrate/push against this
// schema can never silently target the wrong backend.
const rawDatabase = (process.env.DATABASE_URL ?? "").trim();
const rawSource = (process.env.SOURCE_DATABASE_URL ?? "").trim();
const postgresUrl = rawDatabase.startsWith("postgres")
  ? rawDatabase
  : rawSource;

// Fail fast with instructions for commands that actually connect.
const argv = process.argv.slice(2);
const has = (cmd: string) => argv.includes(cmd);
const connectsToDb =
  has("push") ||
  has("pull") ||
  has("studio") ||
  (has("migrate") && !has("diff"));

if (!postgresUrl && connectsToDb) {
  throw new Error(
    "[prisma.postgres.config] No PostgreSQL connection URL found.\n" +
      "  Set DATABASE_URL to a postgresql:// URL (e.g. the Supabase\n" +
      "  transaction URL on port 6543) in .env or the environment,\n" +
      "  then re-run the command.",
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: postgresUrl,
  },
});
