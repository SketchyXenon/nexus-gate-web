import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { registerDeviceKey, revokeDeviceKey } from "@/lib/device-key-server";
import {
  badRequest,
  forbidden,
  notFound,
  parseBody,
  requireAuth,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import { z } from "zod";

// ====================================================================
// POST /api/profile/device-key — register a device public key
// --------------------------------------------------------------------
// Called by the client after login (or on first scan) to register the
// device's Ed25519 public key. The key is used to verify scan
// certificate signatures.
//
// SECURITY (v8 hardening):
//   - Validates the JWK shape (kty=OKP, crv=Ed25519, x=43-char base64url)
//   - Computes the fingerprint SERVER-SIDE (client can't fake it)
//   - Caps at 5 active devices per account (DoS defense)
// ====================================================================

const MAX_DEVICES_PER_ACCOUNT = 5;

const deviceKeySchema = z.object({
  publicKeyJwk: z.object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: z.string().min(43).max(43),
  }),
  fingerprint: z.string().min(64).max(64),
  label: z.string().max(100).optional(),
});

export async function POST(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  const body = await parseBody(req);
  const parsed = deviceKeySchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
  }

  const { publicKeyJwk, fingerprint, label } = parsed.data;

  // ---- SECURITY: Verify the fingerprint matches the public key ----
  // The client supplies both, but the server recomputes the fingerprint
  // to prevent a client from registering a key under a fake fingerprint
  // (which would pollute the audit trail).
  const { computeFingerprint } = await import("@/lib/device-key-server");
  const expectedFingerprint = await computeFingerprint(publicKeyJwk);
  if (expectedFingerprint !== fingerprint) {
    return badRequest(
      "Fingerprint does not match the public key.",
      "FINGERPRINT_MISMATCH",
    );
  }

  // ---- DoS defense: cap active devices per account ----
  const existingCount = await db.deviceKey.count({
    where: { accountId: account.id, revokedAt: null },
  });
  if (existingCount >= MAX_DEVICES_PER_ACCOUNT) {
    return forbidden(
      `Maximum ${MAX_DEVICES_PER_ACCOUNT} active devices per account. Revoke an old device first.`,
      "DEVICE_LIMIT",
    );
  }

  try {
    const deviceKey = await registerDeviceKey({
      accountId: account.id,
      publicKeyJwk,
      fingerprint,
      label,
    });

    await audit({
      actorId: account.id,
      action: "device.register",
      targetType: "DeviceKey",
      targetId: deviceKey.id,
      metadata: { fingerprint, label: label ?? null },
      req,
    });

    return NextResponse.json({ ok: true, id: deviceKey.id, fingerprint });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("already registered to another account")) {
      return badRequest(msg, "DEVICE_IN_USE");
    }
    throw e;
  }
}

// ====================================================================
// GET /api/profile/device-key — list this account's registered devices
// ====================================================================
export async function GET(_req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  const deviceKeys = await db.deviceKey.findMany({
    where: { accountId: account.id },
    select: {
      id: true,
      fingerprint: true,
      label: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    { deviceKeys },
    { headers: { "Cache-Control": "private, no-cache" } },
  );
}

// ====================================================================
// DELETE /api/profile/device-key?keyId=X — revoke a device key
// --------------------------------------------------------------------
// Allows students to self-manage their 5-device cap by revoking old
// devices they no longer use. Revoked keys can't sign new certificates.
// ====================================================================
export async function DELETE(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  const keyId = req.nextUrl.searchParams.get("keyId");
  if (!keyId) return badRequest("Missing keyId parameter");

  const revoked = await revokeDeviceKey(account.id, keyId);
  if (!revoked) return notFound("Device key not found");

  await audit({
    actorId: account.id,
    action: "device.revoke",
    targetType: "DeviceKey",
    targetId: keyId,
    req,
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
