// Bootstrap admin account for Nexus Gate.
// Usage: bun run scripts/bootstrap-admin.ts
// Reads BOOTSTRAP_ADMIN_EMAIL / PASSWORD / NAME from env, or prompts stdin.

import bcrypt from "bcryptjs";
import readline from "readline";
import { db } from "../src/lib/db";

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL || (await ask("Admin email: "));
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || (await ask("Admin password: "));
  const name = process.env.BOOTSTRAP_ADMIN_NAME || (await ask("Admin full name: "));

  if (!email || !password || !name) {
    console.error("Missing email, password, or name.");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const account = await db.account.upsert({
    where: { email },
    create: { email, passwordHash, fullName: name, role: "ADMIN", status: "ACTIVE" },
    update: { passwordHash, fullName: name, role: "ADMIN", status: "ACTIVE" },
  });

  console.log(`Admin ready: ${account.email} (id=${account.id})`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
