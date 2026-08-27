// scripts/diagnose-tidb.ts
// --------------------------------------------------------------------
// Checks EVERY MySQL url the machine can resolve (env + .env, both
// TIDB_DATABASE_URL and DATABASE_URL) against the CURRENT
// prisma/schema.tidb.prisma, and prints a masked identity + per-url
// verdict for each.
//
// WHY THIS EXISTS (the blind spot of db:verify:tidb): verify resolves
// ONE url (TIDB_DATABASE_URL first, then a mysql:// DATABASE_URL) and
// checks only that. Production can STILL drift afterwards when:
//   1. the url pushed/verified locally differs from the one the
//      DEPLOYED app resolves (stale TIDB_DATABASE_URL on Vercel,
//      different database name in the url path, different cluster), or
//   2. TIDB_DATABASE_URL and DATABASE_URL disagree locally, so push
//      and verify quietly targeted different databases.
// This script surfaces BOTH urls side by side, checks each, and tells
// you exactly what to compare against production (GET
// /api/admin/db-health as an ADMIN shows the deployed app's actual
// target and live columns).
//
// Usage:
//   bun run db:diagnose:tidb
//
// Exit codes: 0 = every checked url is in sync, 2 = at least one url
// drifted, 1 = error / nothing to check.
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

interface CandidateUrl {
  url: string;
  sources: string[]; // e.g. ["env TIDB_DATABASE_URL", ".env TIDB_DATABASE_URL"]
}

// Collect every url from every source; merge duplicates (same url
// found via env AND .env keeps both labels).
function collectUrls(): { mysql: CandidateUrl[]; skipped: CandidateUrl[] } {
  const raw: Array<{ source: string; value: string }> = [
    { source: "env TIDB_DATABASE_URL", value: process.env.TIDB_DATABASE_URL ?? "" },
    { source: ".env TIDB_DATABASE_URL", value: readEnvFile("TIDB_DATABASE_URL") },
    { source: "env DATABASE_URL", value: process.env.DATABASE_URL ?? "" },
    { source: ".env DATABASE_URL", value: readEnvFile("DATABASE_URL") },
  ].filter((e) => e.value.trim().length > 0);

  const mysql = new Map<string, CandidateUrl>();
  const skipped = new Map<string, CandidateUrl>();
  for (const { source, value } of raw) {
    const bucket = value.startsWith("mysql://") ? mysql : skipped;
    const existing = bucket.get(value);
    if (existing) existing.sources.push(source);
    else bucket.set(value, { url: value, sources: [source] });
  }
  return {
    mysql: [...mysql.values()],
    skipped: [...skipped.values()],
  };
}

function maskUrl(raw: string): string {
  // file: paths carry no credentials - safe to display as-is. (They are
  // often RELATIVE, which new URL() cannot parse without a base.)
  if (raw.startsWith("file:") || raw.startsWith("postgres:")) return raw;
  try {
    const u = new URL(raw);
    const port = u.port ? `:${u.port}` : "";
    const db = u.pathname.replace(/^\//, "") || "?";
    // Rebuilt from parts: the password and query params never appear.
    const auth = u.username ? `${u.username}:***@` : "";
    return `${u.protocol}//${auth}${u.hostname || "?"}${port}/${db}`;
  } catch {
    return "(unparseable url)";
  }
}

// ---- Hardened Prisma CLI runner (same chain as verify-tidb-schema) ----

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
    candidates.push({
      label: "node node_modules/prisma/build/index.js",
      cmd: "node",
      args: [PRISMA_CLI, ...prismaArgs],
    });
    candidates.push({
      label: "bun node_modules/prisma/build/index.js",
      cmd: process.execPath,
      args: [PRISMA_CLI, ...prismaArgs],
    });
  }
  candidates.push({
    label: "npx --no-install prisma",
    cmd: "npx",
    args: ["--no-install", "prisma", ...prismaArgs],
  });
  candidates.push({
    label: "npx --no-install prisma (shell)",
    cmd: "npx",
    args: ["--no-install", "prisma", ...prismaArgs].map(quoteForShell),
    shell: true,
  });
  return candidates;
}

function runPrisma(prismaArgs: string[], url: string): { run: PrismaRun | null; failures: string[] } {
  // The url travels via env only: prisma resolves it through the
  // schema's env("TIDB_DATABASE_URL") reference.
  const childEnv = { ...process.env, TIDB_DATABASE_URL: url, DATABASE_URL: url };
  const failures: string[] = [];

  for (const c of buildCandidates(prismaArgs)) {
    let r: PrismaRun;
    try {
      r = spawnSync(c.cmd, c.args, {
        encoding: "utf8",
        env: childEnv,
        timeout: 120_000,
        ...(c.shell ? { shell: true } : {}),
      }) as PrismaRun;
    } catch (err) {
      failures.push(`${c.label}: threw ${(err as Error).message}`);
      continue;
    }

    const stdout = (r.stdout || "").trim();
    const stderr = (r.stderr || "").trim();
    const result = { ...r, stdout, stderr };

    const commandNotFound = r.status === 127 || r.status === 9009;
    if (!r.error && !commandNotFound && (r.status === 0 || r.status === 2 || stdout || stderr)) {
      return { run: result, failures };
    }
    if (r.error) {
      const code = r.error.code ? ` [${r.error.code}]` : "";
      failures.push(`${c.label}: could not start - ${r.error.message}${code}`);
    } else if (commandNotFound) {
      failures.push(`${c.label}: not found (exit ${r.status})`);
    } else {
      const how = r.signal ? `killed by signal ${r.signal}` : `exit ${r.status} with no output`;
      failures.push(`${c.label}: ${how}`);
    }
  }

  return { run: null, failures };
}

// --------------------------------------------------------------------
// Main
// --------------------------------------------------------------------

const { mysql: urls, skipped } = collectUrls();

console.log("[diagnose-tidb] Checking every configured MySQL url against prisma/schema.tidb.prisma ...\n");

if (!existsSync(TIDB_SCHEMA)) {
  console.error(`[diagnose-tidb] ${TIDB_SCHEMA} not found - run from an up-to-date checkout.`);
  process.exit(1);
}

for (const s of skipped) {
  console.log(`  (skipped, not MySQL) ${s.sources.join(", ")} -> ${maskUrl(s.url)}`);
}
if (skipped.length > 0) console.log("");

if (urls.length === 0) {
  console.error(
    "[diagnose-tidb] No MySQL url found in env or .env " +
      "(TIDB_DATABASE_URL / DATABASE_URL).\n" +
      "  Nothing to diagnose locally. If production still returns DB_SCHEMA_DRIFT,\n" +
      "  hit GET /api/admin/db-health (as an ADMIN) to see the deployed app's\n" +
      "  actual datasource and live columns.\n",
  );
  process.exit(1);
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

let anyDrift = false;
let anyError = false;
let allCheckedInSync = true;
const results: Array<{ url: CandidateUrl; verdict: "IN_SYNC" | "DRIFT" | "ERROR"; detail: string }> = [];

for (const entry of urls) {
  const { run, failures } = runPrisma(prismaArgs, entry.url);
  const identity = maskUrl(entry.url);
  const from = entry.sources.join(" + ");

  if (!run) {
    anyError = true;
    allCheckedInSync = false;
    results.push({
      url: entry,
      verdict: "ERROR",
      detail: failures.join("; "),
    });
    console.log(`  [ERROR]    ${identity}\n            from: ${from}\n            ${failures.join("; ")}\n`);
    continue;
  }

  if (run.status === 0) {
    results.push({ url: entry, verdict: "IN_SYNC", detail: "" });
    console.log(`  [IN SYNC]  ${identity}\n            from: ${from}\n`);
  } else if (run.status === 2) {
    anyDrift = true;
    allCheckedInSync = false;
    results.push({ url: entry, verdict: "DRIFT", detail: run.stdout || "(no sql printed)" });
    console.log(`  [DRIFT]    ${identity}\n            from: ${from}`);
    console.log(
      (run.stdout || "(no sql printed)")
        .split("\n")
        .map((l) => `            ${l}`)
        .join("\n"),
    );
    console.log("");
  } else {
    anyError = true;
    allCheckedInSync = false;
    const detail = run.stderr || run.stdout || "(no output)";
    results.push({ url: entry, verdict: "ERROR", detail });
    console.log(`  [ERROR]    ${identity}\n            from: ${from}\n            ${detail.split("\n").join("\n            ")}\n`);
  }
}

// ---- Verdict + guidance ----

const drifting = results.filter((r) => r.verdict === "DRIFT");
const erroring = results.filter((r) => r.verdict === "ERROR");

console.log("------------------------------------------------------------");
if (drifting.length > 0) {
  for (const d of drifting) {
    console.log(
      `ACTION: THIS database is behind the current schema:\n` +
        `  ${maskUrl(d.url.url)}\n` +
        `  resolved via ${d.url.sources.join(" + ")}\n` +
        (d.url.sources.some((s) => s.includes("TIDB_DATABASE_URL"))
          ? `  Fix: bun run db:push:tidb   (pushes to TIDB_DATABASE_URL)\n`
          : `  Fix: set TIDB_DATABASE_URL to this url (temporarily or in .env),\n` +
            `       then: bun run db:push:tidb\n`) +
        `  Then: bun run db:verify:tidb && bun run db:diagnose:tidb\n`,
    );
  }
}

if (allCheckedInSync && urls.length > 0) {
  console.log(
    `Every MySQL url this machine can see is IN SYNC with the current schema.\n` +
      `If PRODUCTION still returns DB_SCHEMA_DRIFT, the deployed app is querying\n` +
      `a database that is NOT any of the urls above. Find out which one:\n` +
      `\n` +
      `  1. Sign in to the app as an ADMIN and open:\n` +
      `       GET https://<your-app>/api/admin/db-health\n` +
      `     It reports the deployed app's masked datasource (host / database /\n` +
      `     user - never the password) and the LIVE columns it sees.\n` +
      `  2. Compare that host+database against the urls listed above.\n` +
      `  3. On Vercel (Settings -> Environment Variables -> Production) check BOTH\n` +
      `     DATABASE_URL and TIDB_DATABASE_URL. At runtime the MySQL client uses\n` +
      `     TIDB_DATABASE_URL - if both are set they must be the SAME url.\n` +
      `  4. Fix in whichever direction you prefer:\n` +
      `       - point Vercel's env at the database you pushed (then redeploy), or\n` +
      `       - set your local TIDB_DATABASE_URL to the database Vercel shows and\n` +
      `         run: bun run db:push:tidb && bun run db:verify:tidb\n` +
      `     No code change is needed either way.\n`,
  );
}

if (erroring.length > 0) {
  console.log(
    `NOTE: ${erroring.length} url(s) could not be checked (connection/runtime errors\n` +
      `above). Fix those (credentials, network, IP allowlist) and re-run.\n`,
  );
}

console.log("------------------------------------------------------------");

if (anyDrift) process.exit(2);
if (anyError) process.exit(1);
process.exit(0);
