// scripts/postinstall.mjs
// Provider-aware Prisma client generation (Prisma 7).
// Detects the database provider from DATABASE_URL and generates the client
// from the matching Prisma 7 config file (Prisma 7 moved connection URLs
// out of schema files into prisma.*.config.ts):
//   mysql://     -> prisma.tidb.config.ts      (TiDB / MySQL, schema.tidb.prisma)
//   file:        -> prisma.config.ts           (SQLite local dev)
//   postgresql://-> prisma.postgres.config.ts  (legacy Supabase)
//   (unset)      -> prisma.config.ts           (SQLite dev default)
//
// This runs automatically on `bun install` (postinstall) and before `build`.
// On Vercel, set DATABASE_URL to the TiDB connection string and the correct
// client is generated automatically - no build command changes needed.
//
// The generated client (new `prisma-client` generator) is PROVIDER-AGNOSTIC:
// connections come from driver adapters at runtime (src/lib/db.ts), so the
// generated output only depends on which schema's models were rendered.
//
// TiDB env var mapping:
//   prisma.tidb.config.ts resolves TIDB_DATABASE_URL, or a mysql://
//   DATABASE_URL. The mapping below keeps tooling that reads
//   TIDB_DATABASE_URL directly (db:push:tidb, db:verify:tidb) working when
//   only DATABASE_URL is set in production.
import { execSync } from "node:child_process";

const url = process.env.DATABASE_URL || "";
let config;
if (url.startsWith("mysql")) {
  config = "prisma.tidb.config.ts";
  // Map DATABASE_URL -> TIDB_DATABASE_URL for downstream tooling that
  // expects it (db:push:tidb / db:verify:tidb / diagnose-tidb).
  if (!process.env.TIDB_DATABASE_URL) {
    process.env.TIDB_DATABASE_URL = process.env.DATABASE_URL;
  }
} else if (url.startsWith("postgresql")) {
  config = "prisma.postgres.config.ts";
} else {
  // file: (SQLite dev) or unset -> default SQLite config.
  config = "prisma.config.ts";
}

// Build the command with the env var explicitly passed through, so child
// processes (prisma) inherit TIDB_DATABASE_URL when it was mapped above.
const cmd = `npx --no-install prisma generate --config=${config}`;
try {
  execSync(cmd, { stdio: "inherit", env: process.env });
} catch {
  console.warn(
    `\n[postinstall] prisma generate failed for ${config}.\n` +
      `This usually means prisma is not installed locally.\n` +
      `Run \`bun install\` first, then:\n` +
      `  npx --no-install prisma generate --config=${config}\n`,
  );
}
