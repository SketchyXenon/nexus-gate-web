// scripts/verify-tidb-schema.ts
// --------------------------------------------------------------------
// Verifies that the LIVE TiDB (MySQL) database matches the CURRENT
// prisma/schema.tidb.prisma - i.e. that the deployed code's Prisma
// client won't hit P2021/P2022 (missing table/column) at runtime.
//
// WHY THIS EXISTS: `bun run db:push:tidb` pushes whatever schema is in
// your LOCAL checkout. If the checkout is stale (e.g. you haven't
// pulled the commit that added the v16 override forensics columns),
// the push silently creates an outdated table - and every endpoint
// that queries the new columns returns 500 in production. This script
// turns that silent failure into a 5-second pre/post-deploy check.
//
// HOW: `prisma migrate diff --from-url <live-db> --to-schema-datamodel
// prisma/schema.tidb.prisma --exit-code` lets Prisma itself compute
// the difference (far more reliable than hand-rolling information_schema
// queries). Exit codes: 0 = in sync, 2 = drift, 1 = error.
//
// Usage:
//   bun run db:verify:tidb            # reads TIDB_DATABASE_URL (or a
//                                     # mysql:// DATABASE_URL) from env
//                                     # or .env
//
// Run it AFTER `bun run db:push:tidb` and BEFORE declaring a deploy
// done. Exit code is CI-friendly (non-zero on drift/error).
// --------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ENV_PATH = new URL("../.env", import.meta.url).pathname;

function readEnvFile(key: string): string {
  try {
    const text = readFileSync(ENV_PATH, "utf8");
    const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`, "m"));
    return m ? m[1].replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

function resolveUrl(): string {
  // Priority: real env var, then .env file. TIDB_DATABASE_URL wins;
  // DATABASE_URL is accepted only when it is a mysql:// URL (prod on
  // Vercel sets DATABASE_URL to the TiDB string).
  const candidates = [
    process.env.TIDB_DATABASE_URL,
    readEnvFile("TIDB_DATABASE_URL"),
    process.env.DATABASE_URL,
    readEnvFile("DATABASE_URL"),
  ];
  return candidates.find((u) => typeof u === "string" && u.startsWith("mysql://")) ?? "";
}

const url = resolveUrl();

if (!url) {
  console.error(
    "\n[verify-tidb-schema] No MySQL connection URL found.\n" +
      "Set TIDB_DATABASE_URL (or a mysql:// DATABASE_URL) in your env or .env,\n" +
      "then re-run: bun run db:verify:tidb\n",
  );
  process.exit(1);
}

if (!url.startsWith("mysql://")) {
  console.error(
    `\n[verify-tidb-schema] The resolved URL is not a MySQL/TiDB URL ` +
      `(got: ${url.slice(0, 24)}...).\n` +
      "This script verifies the TiDB schema only. For local SQLite dev the\n" +
      "schema is pushed automatically by `bun run dev`.\n",
  );
  process.exit(1);
}

console.log("[verify-tidb-schema] Comparing live TiDB database against prisma/schema.tidb.prisma ...");

// Let Prisma itself compute the drift. --exit-code makes it exit 2 when
// the schemas differ, 0 when identical. Args array avoids shell-quoting
// issues with passwords in the URL.
const result = spawnSync(
  "npx",
  [
    "--no-install",
    "prisma",
    "migrate",
    "diff",
    "--from-url",
    url,
    "--to-schema-datamodel",
    "prisma/schema.tidb.prisma",
    "--exit-code",
  ],
  { encoding: "utf8", env: process.env },
);

const stdout = (result.stdout || "").trim();
const stderr = (result.stderr || "").trim();

if (result.status === 0) {
  console.log(
    "\n  \u2713 Schema is IN SYNC - the live database matches the current schema.\n",
  );
  process.exit(0);
}

if (result.status === 2) {
  console.error(
    "\n  \u2717 SCHEMA DRIFT DETECTED - the live database does NOT match the current\n" +
      "  schema. The deployed code WILL get P2021/P2022 errors (500s) on every\n" +
      "  query that touches the missing table/column.\n\n" +
      "  Prisma would apply these changes to bring the DB in sync:\n" +
      "  ------------------------------------------------------------\n" +
      `${stdout || "(no detail printed - run the prisma command manually)"}\n` +
      "  ------------------------------------------------------------\n" +
      "  FIX: from an UP-TO-DATE checkout run:\n" +
      "    git pull && bun install\n" +
      "    bun run db:push:tidb        # applies the ALTER TABLEs (additive,\n" +
      "                                # nullable columns - no data loss)\n" +
      "    bun run db:verify:tidb      # re-verify (expect: in sync)\n",
  );
  process.exit(2);
}

console.error(
  "\n[verify-tidb-schema] prisma migrate diff failed (exit " +
    `${result.status}):\n${stderr || stdout || "unknown error"}\n`,
);
process.exit(1);
