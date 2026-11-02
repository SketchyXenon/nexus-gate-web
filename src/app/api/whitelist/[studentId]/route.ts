import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  requireAuth,
  notFound,
  badRequest,
  forbidden,
  parseBody,
} from "@/lib/api";
import { updateWhitelistShiftSchema } from "@/lib/validation";
import { audit } from "@/lib/audit";

// DELETE /api/whitelist/[studentId] (ADMIN)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ studentId: string }> },
) {
  const res = await requireAuth("ADMIN");
  if ("error" in res) return res.error;
  const { account } = res;
  const { studentId } = await params;
  const id = Number(studentId);
  if (!Number.isFinite(id)) return notFound("Invalid student ID");

  try {
    await db.authorizedStudent.delete({ where: { studentId: id } });
  } catch {
    return notFound("Student not found");
  }

  await audit({
    actorId: account.id,
    action: "whitelist.delete",
    targetType: "Whitelist",
    targetId: id,
    req,
  });

  return Response.json({ ok: true });
}

// PATCH /api/whitelist/[studentId] (ORGANIZER+)
// Update the student's day/night class shift. The authorized_students row
// is the source of truth for class assignment; Account.shift mirrors it on
// the next profile sync. ABAC: organizers may only re-tag students inside
// their own program (BOLA / cross-program harvest defense).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ studentId: string }> },
) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;
  const { account } = res;
  const { studentId } = await params;
  const id = Number(studentId);
  if (!Number.isFinite(id)) return notFound("Invalid student ID");

  const body = await parseBody(req);
  const parsed = updateWhitelistShiftSchema.safeParse(body);
  if (!parsed.success) return badRequest("Shift must be DAY or NIGHT");

  const student = await db.authorizedStudent.findUnique({
    where: { studentId: id },
    select: { studentId: true, program: true },
  });
  if (!student) return notFound("Student not found");

  const isAdmin = account.role === "ADMIN";
  if (!isAdmin && (!account.program || student.program !== account.program)) {
    return forbidden("You can only manage students in your own program.");
  }

  await db.authorizedStudent.update({
    where: { studentId: id },
    data: { shift: parsed.data.shift },
  });

  await audit({
    actorId: account.id,
    action: "whitelist.shift",
    targetType: "Whitelist",
    targetId: id,
    metadata: { shift: parsed.data.shift },
    req,
  });

  return Response.json({ ok: true, shift: parsed.data.shift });
}
