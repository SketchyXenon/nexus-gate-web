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
// HOW: `prisma migrate diff --from-schema-datasource <schema>
// --to-schema-datamodel <schema> --exit-code` lets Prisma itself
// compute the difference (far more reliable than hand-rolling
// information_schema queries). Exit codes: 0 = in sync, 2 = drift,
// 1 = error.
//
// IMPLEMENTATION NOTES (v2 - cross-platform hardening):
// - The Prisma CLI is invoked through its LOCAL JS entry
//   (node_modules/prisma/build/index.js), NOT via `npx`.
//   `spawnSync("npx")` fails with ENOENT/EINVAL on Windows (npx is a
//   .cmd shim, not an executable), which previously produced the
//   cryptic "prisma migrate diff failed (exit undefined): unknown
//   error" report. Runtime fallback chain: node -> bun
//   (process.execPath) -> npx -> npx-with-shell.
// - The DB URL is passed through the ENVIRONMENT (TIDB_DATABASE_URL),
//   never on the command line: no shell-quoting hazards and no
//   password visible in the process list. `--from-schema-datasource`
//   makes Prisma resolve env("TIDB_DATABASE_URL") itself.
// - Spawn failures (result.error) are ALWAYS printed - the script can
//   no longer fail with an empty "unknown error" message.
// - Paths are derived from this file's location via fileURLToPath, so
//   the script works from any CWD and on Windows (where
//   url.pathname yields a broken "/C:/..." prefix).
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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ENV_PATH = join(ROOT, ".env");
const PRISMA_CLI = join(ROOT, "node_modules", "prisma", "build", "index.js");
const TIDB_SCHEMA = join(ROOT, "prisma", "schema.tidb.prisma");

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
  return (
    candidates.find((u) => typeof u === "string" && u.startsWith("mysql://")) ??
    ""
  );
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

if (!existsSync(TIDB_SCHEMA)) {
  console.error(
    `\n[verify-tidb-schema] ${TIDB_SCHEMA} not found - run this from an ` +
      "up-to-date checkout of the nexus-gate repo.\n",
  );
  process.exit(1);
}

console.log(
  "[verify-tidb-schema] Comparing live TiDB database against prisma/schema.tidb.prisma ...",
);

// --------------------------------------------------------------------
// Spawn the local Prisma CLI with a runtime fallback chain.
// --------------------------------------------------------------------

interface PrismaRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException;
  stdout: string;
  stderr: string;
}

interface Candidate {
  label: string;
  cmd: string;
  args: string[];
  shell?: boolean;
}

function quoteForShell(arg: string): string {
  return arg.includes(" ") ? `"${arg}"` : arg;
}

function buildCandidates(prismaArgs: string[]): Candidate[] {
  const candidates: Candidate[] = [];
  if (existsSync(PRISMA_CLI)) {
    // Preferred: the official Node runtime (node.exe is directly
    // spawnable on every platform, unlike the npx.cmd shim).
    candidates.push({
      label: "node node_modules/prisma/build/index.js",
      cmd: "node",
      args: [PRISMA_CLI, ...prismaArgs],
    });
    // When this script runs under `bun run`, process.execPath IS bun -
    // and bun executes the Prisma CLI bundle just as well.
    candidates.push({
      label: "bun node_modules/prisma/build/index.js",
      cmd: process.execPath,
      args: [PRISMA_CLI, ...prismaArgs],
    });
  }
  // Last resorts for setups without a local prisma install.
  candidates.push({
    label: "npx --no-install prisma",
    cmd: "npx",
    args: ["--no-install", "prisma", ...prismaArgs],
  });
  // Windows only reachable path for npx (npx is a .cmd shim): through
  // a shell. Safe here because the DB URL never touches argv.
  candidates.push({
    label: "npx --no-install prisma (shell)",
    cmd: "npx",
    args: ["--no-install", "prisma", ...prismaArgs].map(quoteForShell),
    shell: true,
  });
  return candidates;
}

function describeFailure(label: string, r: PrismaRun): string {
  if (r.error) {
    const code = r.error.code ? ` [${r.error.code}]` : "";
    return `${label}: could not start - ${r.error.message}${code}`;
  }
  if (r.status === 127 || r.status === 9009) {
    // sh / cmd.exe "command not found" exit codes.
    return `${label}: not found (exit ${r.status})`;
  }
  const how = r.signal
    ? `killed by signal ${r.signal}`
    : `exit ${r.status} with no output`;
  return `${label}: ${how}`;
}

function runPrisma(prismaArgs: string[]): {
  run: PrismaRun | null;
  failures: string[];
} {
  // The URL travels via env, never argv: Prisma resolves it through the
  // schema's env("TIDB_DATABASE_URL") reference. Both names are set so
  // the schema file could be swapped without touching this script.
  const childEnv = {
    ...process.env,
    TIDB_DATABASE_URL: url,
    DATABASE_URL: url,
  };
  const failures: string[] = [];

  for (const c of buildCandidates(prismaArgs)) {
    let r: PrismaRun;
    try {
      r = spawnSync(c.cmd, c.args, {
        encoding: "utf8",
        env: childEnv,
        timeout: 120_000, // a hung DB connection must not hang the check
        ...(c.shell ? { shell: true } : {}),
      }) as PrismaRun;
    } catch (err) {
      failures.push(`${c.label}: threw ${(err as Error).message}`);
      continue;
    }

    const stdout = (r.stdout || "").trim();
    const stderr = (r.stderr || "").trim();
    const result = { ...r, stdout, stderr };

    // A usable result: the process ran AND produced a verdict (exit
    // 0/2) or any output at all (Prisma always writes errors). A
    // completely silent non-zero exit means the RUNTIME itself crashed
    // (e.g. an incompatible interpreter), and 127/9009 mean "command
    // not found" (shell candidates) - in both cases try the next one.
    const commandNotFound = r.status === 127 || r.status === 9009;
    if (
      !r.error &&
      !commandNotFound &&
      (r.status === 0 || r.status === 2 || stdout || stderr)
    ) {
      return { run: result, failures };
    }
    failures.push(describeFailure(c.label, result));
  }

  return { run: null, failures };
}

const prismaArgs = [
  "migrate",
  "diff",
  "--from-schema-datasource",
  TIDB_SCHEMA,
  "--to-schema-datamodel",
  TIDB_SCHEMA,
  "--exit-code",
];

const { run, failures } = runPrisma(prismaArgs);

if (!run) {
  console.error(
    "\n[verify-tidb-schema] Could not run the Prisma CLI. Attempted runtimes:\n" +
      failures.map((f) => `  - ${f}`).join("\n") +
      "\n\nFIX:\n" +
      "  1. bun install          (installs the local Prisma CLI the script prefers)\n" +
      "  2. ensure `node` or `npx` is on your PATH\n",
  );
  process.exit(1);
}

if (run.status === 0) {
  console.log(
    "\n  \u2713 Schema is IN SYNC - the live database matches the current schema.\n",
  );
  process.exit(0);
}

if (run.status === 2) {
  console.error(
    "\n  \u2717 SCHEMA DRIFT DETECTED - the live database does NOT match the current\n" +
      "  schema. The deployed code WILL get P2021/P2022 errors (500s / 503\n" +
      "  DB_SCHEMA_DRIFT) on every query that touches the missing table/column.\n\n" +
      "  Prisma would apply these changes to bring the DB in sync:\n" +
      "  ------------------------------------------------------------\n" +
      `${run.stdout || "(no detail printed - run the prisma command manually)"}\n` +
      "  ------------------------------------------------------------\n" +
      "  FIX: from an UP-TO-DATE checkout run:\n" +
      "    git pull && bun install\n" +
      "    bun run db:push:tidb        # applies the ALTER TABLEs (additive,\n" +
      "                                # nullable columns - no data loss)\n" +
      "    bun run db:verify:tidb      # re-verify (expect: in sync)\n" +
      "  No Vercel redeploy is required - only the database changes.\n",
  );
  process.exit(2);
}

// Any other status: a real Prisma error (unreachable host, auth
// failure, ...). Surface it with a targeted hint where we can.
const detail = run.stderr || run.stdout || "(no output)";
let hint = "";
if (/P1001/.test(detail)) {
  hint =
    "  Hint (P1001): the database server is unreachable. Check the host/port\n" +
    "  in TIDB_DATABASE_URL, that the TiDB cluster is running, and that your\n" +
    "  IP is allowed (TiDB Cloud: cluster Settings -> IP Access List).\n";
} else if (/P1000/.test(detail)) {
  hint =
    "  Hint (P1000): authentication failed - check the username/password in\n" +
    "  TIDB_DATABASE_URL.\n";
} else if (/P1003/.test(detail)) {
  hint =
    "  Hint (P1003): the database named in the URL does not exist on the\n" +
    "  server - check the database name in TIDB_DATABASE_URL.\n";
}

console.error(
  `\n[verify-tidb-schema] prisma migrate diff failed (exit ${run.status}${run.signal ? `, signal ${run.signal}` : ""}):\n` +
    `${detail}\n${hint}`,
);
process.exit(1);
