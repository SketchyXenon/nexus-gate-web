// Seed sample events for local development.
// Usage: bun run scripts/seed-events.ts
// Requires an existing ADMIN account to own the events.

import { db } from "../src/lib/db";

async function main() {
  const admin = await db.account.findFirst({ where: { role: "ADMIN" } });
  if (!admin) {
    console.error("No ADMIN account found. Run `bun run bootstrap:admin` first.");
    process.exit(1);
  }

  const now = new Date();
  const inHours = (h: number) => new Date(now.getTime() + h * 3600_000);

  const events = [
    {
      title: "Intro to Programming (BSIT-1A)",
      scope: "academic",
      targetProgram: "BSIT",
      targetSection: "1A",
      scheduledAt: inHours(2),
      endsAt: inHours(4),
      ownerId: admin.id,
    },
    {
      title: "All-Hands Department Meeting",
      scope: "departmental",
      scheduledAt: inHours(24),
      endsAt: inHours(25),
      ownerId: admin.id,
    },
    {
      title: "Network Security Lecture (BIT-ET-3B)",
      scope: "academic",
      targetProgram: "BIT-ET",
      targetSection: "3B",
      scheduledAt: inHours(48),
      endsAt: inHours(50),
      ownerId: admin.id,
    },
  ];

  for (const ev of events) {
    await db.event.create({ data: ev });
    console.log(`Seeded: ${ev.title}`);
  }

  console.log(`Done. Seeded ${events.length} events for ${admin.email}.`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
