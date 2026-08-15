// scripts/encode-tidb-url.mjs
// Helper: builds a properly percent-encoded TiDB connection string from
// individual parts, so special characters in the password don't break
// Prisma's URL parser ("invalid IPv6 address" error).
//
// Usage:
//   node scripts/encode-tidb-url.mjs
//   # Then paste individual parts when prompted, OR set them as env vars:
//   TIDB_USER=... TIDB_PASS=... TIDB_HOST=... TIDB_DB=... node scripts/encode-tidb-url.mjs
//
// Prisma requires percent-encoding of special chars in MySQL connection
// strings: @ : / ? # % + & and others. encodeURIComponent handles all of
// them. See https://www.prisma.io/docs/orm/reference/connection-urls
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

async function ask(rl, prompt, fallback) {
  if (fallback) return fallback;
  const val = (await rl.question(prompt)).trim();
  return val;
}

async function main() {
  const rl = readline.createInterface({ input, output });
  try {
    const user = await ask(rl, "TiDB username: ", process.env.TIDB_USER);
    const pass = await ask(
      rl,
      "TiDB password (input is hidden by * in shell history): ",
      process.env.TIDB_PASS,
    );
    const host = await ask(
      rl,
      "TiDB gateway host (e.g. gateway01.us-east-1.prod.aws.tidbcloud.com): ",
      process.env.TIDB_HOST,
    );
    const db =
      (await ask(
        rl,
        "TiDB database name (e.g. test): ",
        process.env.TIDB_DB,
      )) || "test";

    if (!user || !pass || !host) {
      console.error("All of user, password, and host are required.");
      process.exit(1);
    }

    // encodeURIComponent encodes everything that needs encoding for a URL
    // userinfo component: @ : / ? # % [ ] and more. This is what Prisma
    // expects for MySQL connection strings.
    const encUser = encodeURIComponent(user);
    const encPass = encodeURIComponent(pass);
    // IMPORTANT: the SSL param is `sslaccept` (no underscore), NOT `ssl_accept`.
    // TiDB Serverless REQUIRES TLS. With the wrong param name, Prisma silently
    // skips TLS and TiDB rejects with "Connections using insecure transport
    // are prohibited". See https://docs.pingcap.com/tidbcloud/secure-connections-to-serverless-clusters
    const url = `mysql://${encUser}:${encPass}@${host}:4000/${db}?sslaccept=strict`;

    console.log("\n--- Your encoded TIDB_DATABASE_URL ---");
    console.log(url);
    console.log("\nPaste this into your .env file as TIDB_DATABASE_URL.");
    console.log("Verify it works: bun run db:push:tidb");
  } finally {
    rl.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
