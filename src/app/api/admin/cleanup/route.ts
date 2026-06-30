import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api";

// ====================================================================
// POST /api/admin/cleanup
// Removes expired verification tokens and revoked/expired refresh tokens.
// Can be called manually by admins or by a cron job.
// ====================================================================
export async function POST(req: NextRequest) {
  const res = await requireAuth("ADMIN");
  if ("error" in res) return res.error;

  const now = new Date();

  // Delete expired/used verification tokens
  const tokensDeleted = await db.verificationToken.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: now } },
        { usedAt: { not: null } },
      ],
    },
  });

  // Delete expired or revoked refresh tokens (keep nothing stale)
  const refreshDeleted = await db.refreshToken.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: now } },
        { revokedAt: { not: null } },
      ],
    },
  });

  return NextResponse.json({
    ok: true,
    deleted: {
      verificationTokens: tokensDeleted.count,
      refreshTokens: refreshDeleted.count,
    },
  });
}
