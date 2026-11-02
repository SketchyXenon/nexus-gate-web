// ====================================================================
// Shared .env loader for the Prisma 7 config files.
// --------------------------------------------------------------------
// Prisma 7 removed automatic .env loading from the CLI (together with
// the schema-level datasource url). The root configs
// (prisma.config.ts, prisma.tidb.config.ts, prisma.postgres.config.ts)
// call loadProjectEnv() so connection URLs resolve the same way in
// every environment:
//
//   1. Real environment variables ALWAYS win (dotenv semantics). This
//      keeps scripts/verify-tidb-schema.ts working - it passes
//      TIDB_DATABASE_URL through the child process env explicitly.
//   2. .env is loaded from the repo root (resolved from THIS file's
//      location, with process.cwd() as a fallback), so the CLI works
//      from any working directory.
//   3. No .env file (Vercel / CI) is a no-op - real env vars only.
//
// Dependency-free on purpose: uses Node's built-in process.loadEnvFile
// (Node >= 20.12, Bun >= 1.1.21) and falls back to a minimal
// dotenv-compatible parser for anything older.
// ====================================================================
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_CANDIDATES = [
  // <repo>/.env - independent of the CLI's working directory
  join(dirname(fileURLToPath(import.meta.url)), "..", ".env"),
  // Fallback if the config gets bundled and import.meta.url is rewritten
  join(process.cwd(), ".env"),
];

/** Minimal dotenv-compatible parser (KEY=value, quotes, # comments). */
function parseEnvText(text: string): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue; // real env wins
    let value = line.slice(eq + 1).trim();
    // Strip an inline comment from UNQUOTED values (dotenv semantics).
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

let alreadyLoaded = false;

/**
 * Loads the repo-root .env into process.env (without overriding
 * variables that are already set). Safe to call from every config
 * file; repeated calls are no-ops.
 */
export function loadProjectEnv(): void {
  if (alreadyLoaded) return;
  alreadyLoaded = true;

  const envPath = ENV_CANDIDATES.find((p) => existsSync(p));
  if (!envPath) return; // CI / Vercel: real env vars only - nothing to do

  try {
    // Built-in loader (does not override existing process.env entries).
    const proc = process as unknown as {
      loadEnvFile?: (path?: string) => void;
    };
    if (typeof proc.loadEnvFile === "function") {
      proc.loadEnvFile(envPath);
      return;
    }
  } catch {
    // .env unparsable by Node's strict parser - try the lenient parser.
  }

  try {
    parseEnvText(readFileSync(envPath, "utf8"));
  } catch {
    // Unreadable .env - proceed with whatever the environment provides.
  }
}
