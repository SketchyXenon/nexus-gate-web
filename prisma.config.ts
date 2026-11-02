// ====================================================================
// Prisma 7 configuration - LOCAL DEV (SQLite)
// --------------------------------------------------------------------
// Prisma 7 removed the datasource `url` from schema files. Connection
// URLs now live HERE. This is the DEFAULT config (auto-discovered by
// the Prisma CLI) and points at the SQLite dev schema.
//
// Config map (one per schema, selected explicitly via --config):
//   prisma.config.ts           -> prisma/schema.sqlite.prisma  (local dev)
//   prisma.tidb.config.ts      -> prisma/schema.tidb.prisma    (TiDB / MySQL prod)
//   prisma.postgres.config.ts  -> prisma/schema.prisma         (legacy Supabase)
//
// Usage:
//   npx prisma db push --config=prisma.config.ts          (or: bun run db:push)
//   npx prisma db push --config=prisma.tidb.config.ts     (or: bun run db:push:tidb)
// ====================================================================
import { defineConfig } from "prisma/config";
import { loadProjectEnv } from "./prisma/load-env";

// Prisma 7 dropped automatic .env loading - do it here, explicitly.
loadProjectEnv();

export default defineConfig({
  schema: "prisma/schema.sqlite.prisma",
  datasource: {
    // Prisma 7 reads the URL from this file, not from env("DATABASE_URL")
    // inside the schema. Same semantics as the old schema-level reference:
    // whatever protocol DATABASE_URL holds is what `db push` targets.
    // Trim + treat "" as unset, then fall back to the documented
    // local-dev default so a stray empty DATABASE_URL cannot produce
    // Prisma's bare "Connection url is empty" error.
    url: (process.env.DATABASE_URL ?? "").trim() || "file:./db/custom.db",
  },
});
