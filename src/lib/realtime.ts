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
// One retry (after 2s) for transient failures (network errors, 5xx).
// 4xx errors are not retried (they are permanent — bad key, bad channel).
export async function notifyAttendance(
  eventId: number,
  payload: AttendanceEvent,
): Promise<void> {
  const serverKey = process.env.ABLY_SERVER_KEY;
  if (!serverKey) return;

  const channel = `event:${eventId}`;
  // Use Ably REST API directly (no SDK needed on server side).
  const url = `https://rest.ably.io/channels/${encodeURIComponent(channel)}/publish`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Basic ${Buffer.from(serverKey).toString("base64")}`,
  };
  const body = JSON.stringify({ name: "attendance", data: payload });

  const attempt = async (): Promise<boolean> => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        // 5s timeout — prevents Ably from hanging the serverless function.
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return true;
      // 4xx = permanent (bad key, bad request). Don't retry.
      if (res.status >= 400 && res.status < 500) {
        console.error(
          "[realtime] Ably publish rejected (permanent):",
          res.status,
          await res.text(),
        );
        return false;
      }
      // 5xx = transient (Ably server error). Retry once.
      console.warn(
        "[realtime] Ably publish failed (transient):",
        res.status,
        await res.text(),
      );
      return false;
    } catch (e) {
      // Network error / timeout — transient. Retry once.
      console.warn(
        "[realtime] Ably publish error (transient):",
        e instanceof Error ? e.message : e,
      );
      return false;
    }
  };

  // First attempt.
  if (await attempt()) return;

  // One retry after 2s for transient failures only.
  await new Promise((r) => setTimeout(r, 2000));
  await attempt();
}
