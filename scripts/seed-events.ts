// One-time seed script: creates test events for verifying the event-filter logic.
// Run with: bun run scripts/seed-events.ts
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  // Find or create an admin/organizer account to own the events.
  let owner = await db.account.findUnique({ where: { email: "organizer@nexusgate.dev" } });
  if (!owner) {
    owner = await db.account.create({
      data: {
        email: "organizer@nexusgate.dev",
        passwordHash: "$2a$12$placeholderhashplaceholderhashplaceholderhashplaceholderhashplaceholder",
        fullName: "Test Organizer",
        role: "ORGANIZER",
        status: "ACTIVE",
        program: "BSIT",
        section: "A",
      },
    });
    console.log("Created organizer:", owner.email);
  }

  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  const oneDay = 24 * oneHour;

  // 1. Open-to-all event (both targetProgram and targetSection null)
  const openEvent = await db.event.upsert({
    where: { id: 9001 },
    update: {},
    create: {
      id: 9001,
      title: "School-wide Assembly (Open to All)",
      description: "An event open to every student, regardless of course.",
      ownerId: owner.id,
      scope: "departmental",
      targetProgram: null,
      targetSection: null,
      scheduledAt: new Date(now + oneDay),
      status: "active",
    },
  });
  console.log("Created open-to-all event:", openEvent.title);

  // 2. BSIT program-wide event (targetProgram=BSIT, targetSection=null)
  const bsitEvent = await db.event.upsert({
    where: { id: 9002 },
    update: {},
    create: {
      id: 9002,
      title: "BSIT Department Meeting",
      description: "All BSIT students welcome.",
      ownerId: owner.id,
      scope: "academic",
      targetProgram: "BSIT",
      targetSection: null,
      scheduledAt: new Date(now + oneDay),
      status: "active",
    },
  });
  console.log("Created BSIT program-wide event:", bsitEvent.title);

  // 3. BSIT section A event (targetProgram=BSIT, targetSection=A)
  const bsitAEvent = await db.event.upsert({
    where: { id: 9003 },
    update: {},
    create: {
      id: 9003,
      title: "BSIT Section A Special Lecture",
      description: "Only for BSIT section A students.",
      ownerId: owner.id,
      scope: "academic",
      targetProgram: "BSIT",
      targetSection: "A",
      scheduledAt: new Date(now + oneDay),
      status: "active",
    },
  });
  console.log("Created BSIT section A event:", bsitAEvent.title);

  // 4. BSMx program-wide event (should be hidden from BSIT students)
  const bsmxEvent = await db.event.upsert({
    where: { id: 9004 },
    update: {},
    create: {
      id: 9004,
      title: "BSMx Robotics Workshop",
      description: "Mechatronics students only.",
      ownerId: owner.id,
      scope: "academic",
      targetProgram: "BSMx",
      targetSection: null,
      scheduledAt: new Date(now + oneDay),
      status: "active",
    },
  });
  console.log("Created BSMx event:", bsmxEvent.title);

  console.log("\nSeed complete. 4 events created:");
  console.log("  9001 - Open to all");
  console.log("  9002 - BSIT program-wide");
  console.log("  9003 - BSIT section A only");
  console.log("  9004 - BSMx program-wide (should be hidden from BSIT students)");
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
