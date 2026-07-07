// ====================================================================
// Realtime bridge — server-side notifier for the socket.io mini-service.
// Fire-and-forget; falls back silently if the mini-service is down.
// ====================================================================

// Normalize the REALTIME_URL: strip trailing slashes, ensure /emit path.
// Accepts both "https://svc.onrender.com" and "https://svc.onrender.com/emit".
function resolveRealtimeUrl(): string {
  const raw = (process.env.REALTIME_URL || "http://localhost:3003/emit").trim();
  const base = raw.replace(/\/+$/, ""); // strip trailing slash(es)
  // If the URL already ends with /emit, use it as-is. Otherwise append.
  return base.endsWith("/emit") ? base : `${base}/emit`;
}

const REALTIME_URL = resolveRealtimeUrl();

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

export async function notifyAttendance(
  eventId: number,
  payload: AttendanceEvent,
): Promise<void> {
  try {
    await fetch(REALTIME_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "attendance",
        roomId: `event:${eventId}`,
        payload,
      }),
    });
  } catch {
    // Mini-service not running — non-fatal.
  }
}
