// from DATABASE_URL and generates the correct Prisma client:
//   mysql://     -> prisma/schema.tidb.prisma  (TiDB / MySQL)
//   postgresql://-> prisma/schema.prisma        (Supabase Postgres)
//   file:        -> prisma/schema.sqlite.prisma (local dev)
//
// This runs automatically on `bun install` (postinstall) and before `build`.
// On Vercel, set DATABASE_URL to the TiDB connection string and the correct
// client is generated automatically - no build command changes needed.
//
// Uses `npx --no-install prisma` so the LOCAL Prisma CLI (pinned to 6.19.3
// in package.json) is always used. The --no-install flag prevents npx from
// silently downloading a newer major version (e.g. Prisma 7).
//
// TiDB env var mapping:
//   schema.tidb.prisma reads env("TIDB_DATABASE_URL") so local dev can keep
//   DATABASE_URL=SQLite while pushing the TiDB schema via TIDB_DATABASE_URL.
//   In production, DATABASE_URL IS the TiDB URL - we copy it to
//   TIDB_DATABASE_URL here so prisma generate against schema.tidb.prisma
//   finds the connection string in the env var it expects.
import { execSync } from "node:child_process";

const url = process.env.DATABASE_URL || "";
let schema;
if (url.startsWith("mysql")) {
  schema = "prisma/schema.tidb.prisma";
  // schema.tidb.prisma reads env("TIDB_DATABASE_URL"). In production,
  // DATABASE_URL is the TiDB URL - map it so Prisma finds the connection.
  if (!process.env.TIDB_DATABASE_URL && process.env.DATABASE_URL) {
    process.env.TIDB_DATABASE_URL = process.env.DATABASE_URL;
  }
} else if (url.startsWith("file:")) {
  schema = "prisma/schema.sqlite.prisma";
} else {
  schema = "prisma/schema.prisma";
}

// Build the command with the env var explicitly passed through, so child
// processes (prisma) inherit TIDB_DATABASE_URL when generating the TiDB client.
const cmd = `npx --no-install prisma generate --schema=${schema}`;
try {
  execSync(cmd, { stdio: "inherit", env: process.env });
} catch {
  console.warn(
    `\n[postinstall] prisma generate failed for ${schema}.\n` +
      `This usually means prisma is not installed locally.\n` +
      `Run \`bun install\` first, then:\n` +
      `  npx --no-install prisma generate --schema=${schema}\n`,
  );
}
