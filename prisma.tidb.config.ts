// ====================================================================
// Prisma 7 configuration - TiDB / MySQL (production)
// --------------------------------------------------------------------
// Prisma 7 removed the datasource `url` from schema files, so the TiDB
// connection string lives HERE instead of prisma/schema.tidb.prisma.
// Prisma 7 also stopped auto-loading .env, so this config loads it
// explicitly via prisma/load-env.ts before resolving the URL.
//
// Resolution order (mirrors scripts/verify-tidb-schema.ts):
//   1. TIDB_DATABASE_URL  (dedicated TiDB URL - local dev keeps
//      DATABASE_URL pointing at SQLite)
//   2. DATABASE_URL       (only when it is a mysql:// URL - production
//      on Vercel sets DATABASE_URL to the TiDB string)
//
// Usage:
//   bun run db:push:tidb      -> prisma db push    --config=prisma.tidb.config.ts
//   bun run db:generate:tidb  -> prisma generate   --config=prisma.tidb.config.ts
//   bun run db:verify:tidb    -> scripts/verify-tidb-schema.ts (same config)
// ====================================================================
import { defineConfig } from "prisma/config";
import { loadProjectEnv } from "./prisma/load-env";

// Prisma 7 dropped automatic .env loading - do it here, explicitly.
loadProjectEnv();

// Trim + treat "" as unset, so a stray empty value in .env or the
// environment cannot leak into Prisma as an empty URL.
const rawTidb = (process.env.TIDB_DATABASE_URL ?? "").trim();
const rawDatabase = (process.env.DATABASE_URL ?? "").trim();
const tidbUrl = rawTidb || (rawDatabase.startsWith("mysql") ? rawDatabase : "");

// `generate` / `validate` / `format` never touch the database, so they
// must keep working without a URL (scripts/postinstall.mjs relies on
// this during `bun install` and on Vercel). Commands that actually
// connect fail fast below with actionable instructions instead of
// Prisma's bare "Connection url is empty" error. `migrate diff` is
// exempt because it can diff two schema files without a database.
const argv = process.argv.slice(2);
const has = (cmd: string) => argv.includes(cmd);
const connectsToDb =
  has("push") ||
  has("pull") ||
  has("studio") ||
  (has("migrate") && !has("diff"));

if (!tidbUrl) {
  const message =
    "[prisma.tidb.config] No TiDB connection URL found.\n" +
    "  Add this line to .env in the project root (real values from your\n" +
    "  TiDB Cloud cluster > Connect; percent-encode the password!):\n" +
    '    TIDB_DATABASE_URL="mysql://USER:ENC_PASSWORD@GATEWAY.tidb.com:4000/DBNAME?sslaccept=strict"\n' +
    "  Encode the password with: node scripts/encode-tidb-url.mjs\n" +
    "  Then re-run: bun run db:push:tidb";
  if (connectsToDb) {
    throw new Error(message);
  }
  console.warn(
    `${message}\n  (continuing - this command does not need a connection)`,
  );
} else if (!tidbUrl.startsWith("mysql")) {
  console.warn(
    "[prisma.tidb.config] The resolved URL does not look like a MySQL URL " +
      `(starts with "${tidbUrl.slice(0, 12)}...").\n` +
      "  TiDB connects over the mysql:// protocol - double-check the value " +
      "(see example.env).",
  );
}

export default defineConfig({
  schema: "prisma/schema.tidb.prisma",
  datasource: {
    url: tidbUrl,
  },
});
