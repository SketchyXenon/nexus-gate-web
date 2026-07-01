import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { z } from "zod";
import { badRequest, parseBody, requireAuth } from "@/lib/api";
import { audit } from "@/lib/audit";
import { validatePushEndpoint } from "@/lib/url-safety";

// ====================================================================
// POST /api/notifications/subscribe
// Stores the browser's push notification subscription (Web Push API).
// The browser generates this subscription when the user grants
// notification permission.
//
// SSRF DEFENSE (pentest SSRF-01): The endpoint URL is validated to
// ensure it points to a legitimate push service (HTTPS, not localhost,
// not a private/internal IP, not a cloud metadata endpoint). Without
// this, an attacker could register an internal URL as their push
// endpoint, and if the server later sends a push notification, it
// would issue a POST to that internal URL (SSRF).
// ====================================================================

const subscriptionSchema = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
});

export async function POST(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  const body = await parseBody(req);
  const parsed = subscriptionSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid subscription");
  }

  // "in-app" is a sentinel for in-app notifications (no Web Push
  // subscription). The client sends this when the user enables
  // notifications but the browser hasn't registered a real push
  // subscription (e.g. no VAPID keys configured, or the user only wants
  // in-app bell notifications). Skip the URL validation for this sentinel.
  const isInAppSentinel = parsed.data.endpoint === "in-app";

  // SSRF defense: validate the push endpoint URL — but only for real
  // Web Push endpoints (not the "in-app" sentinel).
  if (!isInAppSentinel) {
    const urlCheck = validatePushEndpoint(parsed.data.endpoint);
    if (!urlCheck.ok) {
      return badRequest(
        `Invalid push endpoint: ${urlCheck.reason}. The endpoint must be a valid HTTPS push service URL.`,
        "INVALID_ENDPOINT"
      );
    }
  }

  await db.account.update({
    where: { id: account.id },
    data: {
      notificationEndpoint: parsed.data.endpoint,
      notificationKeys: JSON.stringify(parsed.data.keys),
      notificationEnabled: true,
    },
  });

  await audit({
    actorId: account.id,
    action: "notifications.subscribe",
    targetType: "Account",
    targetId: account.id,
    req,
  });

  return NextResponse.json({ ok: true, message: "Notifications enabled." });
}

// ====================================================================
// DELETE /api/notifications/subscribe
// Removes the subscription (user turned off notifications).
// ====================================================================
export async function DELETE(req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  await db.account.update({
    where: { id: account.id },
    data: {
      notificationEndpoint: null,
      notificationKeys: null,
      notificationEnabled: false,
    },
  });

  await audit({
    actorId: account.id,
    action: "notifications.unsubscribe",
    targetType: "Account",
    targetId: account.id,
    req,
  });

  return NextResponse.json({ ok: true, message: "Notifications disabled." });
}
