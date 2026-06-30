import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, notFound } from "@/lib/api";
import { audit } from "@/lib/audit";

// DELETE /api/whitelist/[studentId] (ADMIN)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ studentId: string }> }
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
    actorId: account.id, action: "whitelist.delete", targetType: "Whitelist",
    targetId: id, req,
  });

  return Response.json({ ok: true });
}
