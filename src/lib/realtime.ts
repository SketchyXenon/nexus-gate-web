// ====================================================================
// Realtime bridge — server-side notifier for the socket.io mini-service.
// Fire-and-forget; falls back silently if the mini-service is down.
// ====================================================================

const REALTIME_URL =
  process.env.REALTIME_URL || "http://localhost:3003/emit";

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
  payload: AttendanceEvent
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
