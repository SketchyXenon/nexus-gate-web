import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api";
import { audit } from "@/lib/audit";

// ====================================================================
// POST /api/admin/cleanup
// Removes expired verification tokens and revoked/expired refresh tokens.
// Can be called manually by admins or by a cron job.
// ====================================================================
export async function POST(req: NextRequest) {
  const res = await requireAuth("ADMIN");
  if ("error" in res) return res.error;
  const { account } = res;

  const now = new Date();

  // Run both deletes in parallel for faster response.
  const [tokensDeleted, refreshDeleted] = await Promise.all([
    db.verificationToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }],
      },
    }),
    db.refreshToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }],
      },
    }),
  ]);

  await audit({
    actorId: account.id,
    action: "admin.manual_cleanup",
    targetType: "System",
    metadata: {
      verificationTokens: tokensDeleted.count,
      refreshTokens: refreshDeleted.count,
    },
    req,
  }).catch(() => {});

  return NextResponse.json({
    ok: true,
    deleted: {
      verificationTokens: tokensDeleted.count,
      refreshTokens: refreshDeleted.count,
    },
  });
}
