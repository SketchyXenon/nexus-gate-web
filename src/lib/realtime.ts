// ====================================================================
// Realtime bridge — publishes attendance events via Ably.
// --------------------------------------------------------------------
// Replaces the Render socket.io mini-service. Ably is a managed
// realtime platform (free tier: 3M messages/month, 200 concurrent
// connections). No server to maintain, no spin-down, no cold starts.
//
// ENV: ABLY_SERVER_KEY must be set (Ably server API key, NOT the
// browser key — the server key can publish, the browser key can only
// subscribe). Get both from the Ably dashboard.
// ====================================================================

export interface AttendanceEvent {
  id: number;
  accountId: string;
  fullName: string;
  studentId: number | null;
  program: string | null;
  section: string | null;
  scannedAt: string;
  source: string;
}

// Publish an attendance event to the event's Ably channel.
// Fire-and-forget — fails silently if Ably is not configured.
export async function notifyAttendance(
  eventId: number,
  payload: AttendanceEvent,
): Promise<void> {
  const serverKey = process.env.ABLY_SERVER_KEY;
  if (!serverKey) return;

  try {
    const channel = `event:${eventId}`;
    // Use Ably REST API directly (no SDK needed on server side).
    // This avoids importing the Ably SDK in the serverless function.
    const res = await fetch(
      `https://rest.ably.io/channels/${encodeURIComponent(channel)}/publish`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(serverKey).toString("base64")}`,
        },
        body: JSON.stringify({
          name: "attendance",
          data: payload,
        }),
      },
    );
    if (!res.ok) {
      console.error(
        "[realtime] Ably publish failed:",
        res.status,
        await res.text(),
      );
    }
  } catch (e) {
    // Non-fatal — attendance is still recorded in the DB.
    console.error("[realtime] Ably publish error:", e);
  }
}
