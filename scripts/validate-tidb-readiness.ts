// ====================================================================
// Nexus Gate - TiDB migration readiness validator
// --------------------------------------------------------------------
// Run BEFORE the cutover. Confirms every prerequisite is met so the
// migration can proceed without surprise failures mid-cutover.
//
// Usage: bun run scripts/validate-tidb-readiness.ts
// Exit 0 = ready, 1 = not ready (prints what's missing).
// ====================================================================

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type Check = { name: string; pass: boolean; detail: string };

function check(name: string, fn: () => boolean | string): Check {
  try {
    const result = fn();
    if (result === true) return { name, pass: true, detail: "" };
    return { name, pass: false, detail: typeof result === "string" ? result : "failed" };
  } catch (e) {
    return { name, pass: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

const checks: Check[] = [];

// 1. TiDB schema file exists + uses mysql provider
checks.push(
  check("TiDB schema exists", () => {
    const path = "prisma/schema.tidb.prisma";
    return existsSync(path) ? true : `missing ${path}`;
  }),
  check("TiDB schema uses mysql provider", () => {
    const src = readFileSync("prisma/schema.tidb.prisma", "utf-8");
    return /provider\s*=\s*"mysql"/.test(src) ? true : "provider is not mysql";
  }),
);

// 2. Schema parity (Postgres and TiDB define the same models)
checks.push(
  check("schema parity (same model count)", () => {
    function countModels(path: string): number {
      const src = readFileSync(path, "utf-8");
      return (src.match(/^model\s+\w+\s*{/gm) || []).length;
    }
    const pg = countModels("prisma/schema.prisma");
    const tidb = countModels("prisma/schema.tidb.prisma");
    return pg === tidb ? true : `Postgres=${pg}, TiDB=${tidb}`;
  }),
);

// 3. No raw SQL against auth.users (the Supabase-internal coupling)
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}
checks.push(
  check("no auth.users raw SQL coupling", () => {
    const files = listTsFiles("src/app/api");
    const codeRefs: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      for (const line of src.split("\n")) {
        if (!line.includes("auth.users")) continue;
        const trimmed = line.trim();
        // Allow comments only.
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        codeRefs.push(`${file}: ${trimmed}`);
      }
    }
    return codeRefs.length === 0 ? true : `code references: ${codeRefs.join("; ")}`;
  }),
);

// 4. Migration script exists
checks.push(
  check("migration script exists", () => {
    return existsSync("scripts/migrate-to-tidb.ts") ? true : "missing scripts/migrate-to-tidb.ts";
  }),
);

// 5. Runbook exists
checks.push(
  check("migration runbook exists", () => {
    return existsSync("docs/tidb-migration-runbook.md") ? true : "missing docs/tidb-migration-runbook.md";
  }),
);

// 6. npm scripts registered
checks.push(
  check("db:push:tidb script registered", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
    return pkg.scripts["db:push:tidb"] ? true : "missing in package.json";
  }),
  check("migrate:tidb script registered", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
    return pkg.scripts["migrate:tidb"] ? true : "missing in package.json";
  }),
);

// 7. RLS deny-all migration exists (for the Supabase side - documents intent)
checks.push(
  check("RLS deny-all migration exists (0020)", () => {
    return existsSync("supabase/migrations/0020_rls_deny_all_server_only_tables.sql")
      ? true
      : "missing 0020 migration";
  }),
);

// 8. env vars (warn, not fail - these are set at cutover time)
checks.push(
  check("DATABASE_URL is set (current dev/prod)", () => {
    return process.env.DATABASE_URL ? true : "not set in current env (ok for dev check)";
  }),
);

// Report
console.log("=== Nexus Gate: TiDB Migration Readiness ===\n");
let allPass = true;
for (const c of checks) {
  const status = c.pass ? "PASS" : "FAIL";
  const detail = c.detail ? ` - ${c.detail}` : "";
  console.log(`[${status}] ${c.name}${detail}`);
  if (!c.pass) allPass = false;
}
console.log(
  allPass ? "\nREADY: all prerequisites met. Proceed with the runbook." : "\nNOT READY: fix the failures above.",
);
process.exit(allPass ? 0 : 1);
