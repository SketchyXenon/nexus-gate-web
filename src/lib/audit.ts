// ====================================================================
// Nexus Gate — Audit Logger
// Append-only accountability trail. Every mutation is recorded with
// actor, action, target, metadata, and request context.
// ====================================================================

import { db } from "@/lib/db";
import type { NextRequest } from "next/server";
import { getClientIp } from "@/lib/api";

export interface AuditParams {
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string | number | null;
  metadata?: Record<string, unknown>;
  req?: NextRequest;
}

export async function audit(params: AuditParams): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorId: params.actorId ?? null,
        action: params.action,
        targetType: params.targetType ?? null,
        targetId: params.targetId != null ? String(params.targetId) : null,
        metadata: params.metadata ? JSON.stringify(params.metadata) : null,
        ipAddress: params.req ? getClientIp(params.req) : "unknown",
        userAgent: params.req?.headers.get("user-agent") ?? null,
      },
    });
  } catch (e) {
    // Audit logging must never break the request flow.
    console.error("[audit] failed to write log:", e);
  }
}
