// scripts/migrate-to-tidb.ts
// One-time data migration: copies app-data tables from Supabase Postgres
// (SOURCE_DATABASE_URL) to TiDB/MySQL (TIDB_DATABASE_URL). Auth stays on
// Supabase - only the app-data tables move; auth.users is NOT touched.
//
// PREREQUISITES (run in order):
//   1. Set TIDB_DATABASE_URL to the TiDB connection string (mysql://...).
//   2. Set SOURCE_DATABASE_URL to the Supabase Postgres connection string.
//   3. bun run db:generate:tidb   (builds the Prisma client into
//      src/generated/prisma - Prisma 7 clients are provider-agnostic)
//   4. bun run db:push:tidb       (creates the schema on TiDB)
//   5. bun run migrate:tidb       (this script - copies the data)
//
// PRISMA 7 NOTES:
// - The generated client (src/generated/prisma) is PROVIDER-AGNOSTIC:
//   connections come from driver adapters, so the old "generated client
//   must be the MySQL build" check is obsolete. The destination client is
//   wired to TiDB with @prisma/adapter-mariadb (via src/lib/db-adapter),
//   the source client to Postgres with @prisma/adapter-pg.
// - The Postgres source client is generated into ./generated/source via a
//   TEMPORARY SCHEMA (output path swapped) - `prisma generate --schema=`
//   still works in Prisma 7 and does not touch the app's generated client.
//
// Tables are copied in foreign-key dependency order and the copy is
// idempotent (skipDuplicates), so re-running resumes safely.
//
// See docs/tidb-migration-runbook.md for the full cutover + rollback.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createAdapterFromUrl } from "@/lib/db-adapter";

// Prisma 7: the generated client is provider-agnostic, so there is no
// "MySQL build" to verify. The real prerequisite is that the generated
// output EXISTS - if it doesn't, every model delegate is undefined.
function ensureGeneratedClient(): void {
  const clientPath = resolve("src/generated/prisma/client.ts");
  if (!existsSync(clientPath)) {
    console.error(
      "The Prisma client has not been generated yet (src/generated/prisma/client.ts missing).\n\n" +
        "Run this first, then re-run the migration:\n" +
        "  bun run db:generate:tidb\n\n" +
        "(Any db:generate variant works - Prisma 7 clients are provider-agnostic;\n" +
        "DATABASE_URL can stay as SQLite for local dev.)",
    );
    process.exit(1);
  }
}

// Generate the Postgres source client into ./generated/source so it does
// not overwrite the app's generated client (src/generated/prisma).
// Prisma 7: we swap the generator's `output` line into a temporary schema
// file and run `prisma generate --schema=` (still supported; it overrides
// the config's schema without touching the app client), then clean up.
function ensureSourceClient() {
  console.log("Generating Postgres source client into ./generated/source ...");
  const sourceSchemaPath = resolve("prisma/schema.prisma");
  const tempSchemaPath = resolve("prisma/.source.tmp.prisma");
  const sourceSchema = readFileSync(sourceSchemaPath, "utf8");

  // Swap the existing `output = "../src/generated/prisma"` line to the
  // isolated ./generated/source directory.
  const tempSchema = sourceSchema.replace(
    /output\s*=\s*"[^"]*"/,
    `output                 = "../generated/source"`,
  );

  if (tempSchema === sourceSchema) {
    // Fallback: if the regex didn't match (unexpected schema format),
    // insert the output line right after the provider line.
    const withInsert = sourceSchema.replace(
      /(generator\s+client\s*\{[^}]*provider\s*=\s*"[^"]*")/,
      `$1\n  output                 = "../generated/source"`,
    );
    if (withInsert === sourceSchema) {
      throw new Error(
        "Could not inject output path into prisma/schema.prisma generator block. " +
          "Check the generator block syntax.",
      );
    }
    writeFileSync(tempSchemaPath, withInsert);
  } else {
    writeFileSync(tempSchemaPath, tempSchema);
  }

  try {
    execSync(
      `npx --no-install prisma generate --schema=prisma/.source.tmp.prisma`,
      { stdio: "inherit" },
    );
  } finally {
    // Clean up the temp schema file (keep generated/source - it's gitignored).
    if (existsSync(tempSchemaPath)) {
      unlinkSync(tempSchemaPath);
    }
  }
}

// Tables in foreign-key dependency order (parents before children).
// NOTE: the Schedule model was added AFTER this one-time migration ran -
// schedule rows start fresh on TiDB and are intentionally NOT copied.
const TABLES = [
  "account",
  "authorizedStudent",
  "setting",
  "event",
  "verificationToken",
  "refreshToken",
  "deviceKey",
  "termsAcceptance",
  "eventAttendance",
  "attendanceOverride",
  "notification",
  "auditLog",
  "visit",
] as const;

type ModelName = (typeof TABLES)[number];

// ---- Schema-drift detection (fail fast with the exact fix) ----
// Both the source (Supabase Postgres) and the destination (TiDB) must
// match THIS checkout's schemas, or a findMany/createMany on a drifted
// table throws a scary P2021/P2022 stack mid-migration. These helpers
// turn that into a targeted one-line instruction BEFORE anything is
// copied (pre-flight) and, as defense in depth, at each table copy.

interface DriftLikeError {
  code?: string;
  message?: string;
  meta?: { column?: string; table?: string };
}

/** P2021 (table missing) / P2022 (column missing) classifier. */
export function asDriftError(
  e: unknown,
): { kind: "P2021" | "P2022"; what: string } | null {
  if (typeof e !== "object" || e === null) return null;
  const err = e as DriftLikeError;
  if (err.code === "P2021" || err.code === "P2022") {
    const what =
      err.meta?.column ??
      err.meta?.table ??
      (err.message ?? "").split("\n")[0] ??
      "unknown";
    return { kind: err.code, what };
  }
  return null;
}

function sourceDriftFix(): string {
  return (
    "Push the CURRENT Postgres schema to the SOURCE database first " +
    "(runbook Phase 1 - docs/tidb-migration-runbook.md):\n" +
    "  PowerShell:\n" +
    '    $env:DATABASE_URL="<Supabase Postgres URL (session mode, port 5432, preferred)>"\n' +
    "    npx --no-install prisma db push --config=prisma.postgres.config.ts\n" +
    "    Remove-Item Env:DATABASE_URL\n" +
    "  bash:\n" +
    '    DATABASE_URL="<Supabase Postgres URL>" \\\n' +
    "      npx --no-install prisma db push --config=prisma.postgres.config.ts"
  );
}

function destDriftFix(): string {
  return (
    "Push the CURRENT TiDB schema to the DEST database first:\n" +
    "  bun run db:push:tidb && bun run db:verify:tidb"
  );
}

/**
 * Verifies every table in TABLES can be read (findMany take:1 selects
 * every scalar column, so any missing table/column throws). Exits with
 * a targeted fix message on drift - BEFORE any data is copied.
 */
export async function preflightSchemaDrift(
  client: { [k: string]: any },
  label: "SOURCE" | "DEST",
): Promise<void> {
  console.log(
    `Pre-flight: verifying the ${label} database matches the current schema ...`,
  );
  for (const name of TABLES) {
    try {
      await client[name].findMany({ take: 1 });
    } catch (e) {
      const drift = asDriftError(e);
      if (!drift) throw e;
      const fix = label === "SOURCE" ? sourceDriftFix() : destDriftFix();
      console.error(
        `\n[migrate] ${label} database is BEHIND the current schema: ` +
          `${name} is missing ${drift.what} (${drift.kind}).\n\n${fix}\n\n` +
          "Nothing has been copied yet. After the push, re-run: " +
          "bun run migrate:tidb (the copy is idempotent).\n" +
          "See docs/tidb-migration-runbook.md for the full procedure.\n",
      );
      process.exit(1);
    }
  }
  console.log(
    `  ${label}: schema OK (${TABLES.length} tables introspected cleanly)`,
  );
}

export async function copyTable(
  source: { [k: string]: any },
  dest: { [k: string]: any },
  name: ModelName,
) {
  let rows: any[];
  try {
    rows = await source[name].findMany();
  } catch (e) {
    const drift = asDriftError(e);
    if (drift) {
      console.error(
        `\n[migrate] SOURCE drift on ${name} (missing ${drift.what}):\n\n` +
          `${sourceDriftFix()}\n\n` +
          "Tables copied before this one are safe - the copy is idempotent " +
          "(skipDuplicates). Re-run after the push.\n",
      );
      process.exit(1);
    }
    throw e;
  }
  if (rows.length === 0) {
    console.log(`  ${name}: 0 rows (skipped)`);
    return;
  }
  // createMany with skipDuplicates makes the copy idempotent. The mariadb
  // driver adapter supports this; the composite @id/@unique constraints
  // resolve conflicts. BigInt/Decimal/DateTime values are serialized by
  // Prisma.
  try {
    await dest[name].createMany({ data: rows as never, skipDuplicates: true });
  } catch (e) {
    const drift = asDriftError(e);
    if (drift) {
      console.error(
        `\n[migrate] DEST drift on ${name} (missing ${drift.what}):\n\n` +
          `${destDriftFix()}\n\n` +
          "Tables copied before this one are safe - the copy is idempotent " +
          "(skipDuplicates). Re-run after the push.\n",
      );
      process.exit(1);
    }
    throw e;
  }
  console.log(`  ${name}: ${rows.length} rows copied`);
}

async function main() {
  // 1. Verify the TiDB destination URL is set.
  const tidbUrl = process.env.TIDB_DATABASE_URL;
  if (!tidbUrl || !tidbUrl.startsWith("mysql")) {
    console.error(
      "TIDB_DATABASE_URL is not set or is not a mysql:// URL.\n" +
        "Set it in .env to your TiDB connection string, then re-run.",
    );
    process.exit(1);
  }

  // 2. Verify the Supabase source URL is set.
  if (!process.env.SOURCE_DATABASE_URL) {
    console.error(
      "SOURCE_DATABASE_URL is not set. Point it at the Supabase Postgres source.",
    );
    process.exit(1);
  }

  // 3. Verify the generated client exists (Prisma 7: provider-agnostic,
  // so there is no "MySQL build" check - just make sure db:generate ran).
  ensureGeneratedClient();

  console.log("Pre-flight checks passed:");
  console.log(`  - Generated Prisma client: src/generated/prisma (OK)`);
  console.log(`  - TIDB_DATABASE_URL: set (mysql://)`);
  console.log(`  - SOURCE_DATABASE_URL: set`);
  console.log("");

  ensureSourceClient();

  // Dynamic import of the generated source client (Prisma 7 emits TS
  // sources - bun executes them natively). Path is relative to this
  // script file (scripts/), so ../generated/source/client.ts. Variable
  // path so TypeScript does not statically resolve it.
  const sourcePath = "../generated/source/client.ts";
  const sourceModule: any = await import(sourcePath);
  const SourcePrismaClient = sourceModule.PrismaClient;
  const source = new SourcePrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.SOURCE_DATABASE_URL,
    }),
  });

  // Dest client: the app's generated PrismaClient wired to TiDB through
  // the mariadb driver adapter (TIDB_DATABASE_URL - NOT DATABASE_URL,
  // which may point to SQLite for local dev).
  const dest = new PrismaClient({
    adapter: createAdapterFromUrl(tidbUrl),
  });

  console.log(
    `Source: Supabase Postgres (${process.env.SOURCE_DATABASE_URL.replace(/:[^:@]+@/, ":****@")})`,
  );
  console.log(
    `Dest:   TiDB/MySQL      (${tidbUrl.replace(/:[^:@]+@/, ":****@")})`,
  );

  // Fail fast: verify BOTH databases match the current schemas BEFORE
  // copying anything. A drifted SOURCE (Supabase behind the checkout - the
  // classic "forgot Phase 1" case) or a drifted DEST (TiDB not pushed from
  // this checkout) exits here with the exact fix command, instead of a
  // P2022 stack dump halfway through the copy.
  await preflightSchemaDrift(source, "SOURCE");
  await preflightSchemaDrift(dest as unknown as { [k: string]: any }, "DEST");

  console.log("Copying tables in dependency order:");

  try {
    for (const t of TABLES) {
      await copyTable(source, dest as unknown as { [k: string]: any }, t);
    }
    console.log("\nMigration complete.");
  } finally {
    await source.$disconnect();
    await dest.$disconnect();
  }
}

// Run only when executed directly (`bun run scripts/migrate-to-tidb.ts`),
// not when imported (tests import the exported helpers).
const importMeta = import.meta as ImportMeta & { main?: boolean };
if (importMeta.main ?? false) {
  main().catch((e) => {
    console.error("Migration failed:", e);
    process.exit(1);
  });
}
