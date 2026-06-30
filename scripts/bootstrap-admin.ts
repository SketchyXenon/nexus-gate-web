#!/usr/bin/env bun
// ====================================================================
// Nexus Gate — Bootstrap Admin Account
// --------------------------------------------------------------------
// Creates the FIRST admin account. Run this ONCE to seed the initial
// administrator, then use the admin panel to manage all subsequent
// accounts.
//
// Usage:
//   bun run scripts/bootstrap-admin.ts
//
// Environment variables (optional — prompts if not set):
//   BOOTSTRAP_ADMIN_EMAIL     — the admin's email
//   BOOTSTRAP_ADMIN_PASSWORD  — the admin's password (min 8 chars)
//   BOOTSTRAP_ADMIN_NAME      — the admin's full name
//
// If the admin already exists, the script updates the password and
// role (idempotent — safe to re-run).
// ====================================================================

import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth";
import * as readline from "readline";

const db = new PrismaClient();

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log("=== Nexus Gate — Bootstrap Admin ===\n");

  // Get credentials from env or prompt
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL || await prompt("Admin email: ");
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || await prompt("Admin password (min 8 chars, 1 upper, 1 lower, 1 number): ");
  const fullName = process.env.BOOTSTRAP_ADMIN_NAME || await prompt("Admin full name: ");

  // Validate
  if (!email || !email.includes("@")) {
    console.error("Error: A valid email is required.");
    process.exit(1);
  }
  if (!password || password.length < 8) {
    console.error("Error: Password must be at least 8 characters.");
    process.exit(1);
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    console.error("Error: Password must include uppercase, lowercase, and a number.");
    process.exit(1);
  }
  if (!fullName || fullName.length < 2) {
    console.error("Error: Full name is required.");
    process.exit(1);
  }

  // Hash the password
  console.log("\nHashing password...");
  const passwordHash = await hashPassword(password);

  // Create or update the admin account (idempotent)
  console.log(`Creating/updating admin account for ${email}...`);
  const admin = await db.account.upsert({
    where: { email: email.toLowerCase() },
    update: {
      passwordHash,
      role: "ADMIN",
      status: "ACTIVE",
      fullName,
    },
    create: {
      email: email.toLowerCase(),
      passwordHash,
      fullName,
      role: "ADMIN",
      status: "ACTIVE",
    },
  });

  console.log(`\n✓ Admin account ready!`);
  console.log(`  ID:       ${admin.id}`);
  console.log(`  Email:    ${admin.email}`);
  console.log(`  Name:     ${admin.fullName}`);
  console.log(`  Role:     ${admin.role}`);
  console.log(`  Status:   ${admin.status}`);
  console.log(`\nYou can now sign in at the login page.`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error("Failed to bootstrap admin:", e);
    await db.$disconnect();
    process.exit(1);
  });
