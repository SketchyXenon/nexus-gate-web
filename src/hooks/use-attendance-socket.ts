"use client";

import { useEffect, useRef, useState } from "react";
import Ably from "ably";

// ====================================================================
// useAttendanceSocket — subscribes to a per-event live attendance channel.
// --------------------------------------------------------------------
// Uses Ably (managed realtime, free tier: 200 concurrent connections,
// 3M messages/month). Replaces the Render socket.io mini-service which
// spun down after 15 min on the free tier.
//
// Only organizers connect to Ably (students don't need realtime — they
// scan and get an immediate result). At 200 concurrent users: ~10-20
// Ably connections (well under the 200 free-tier limit).
//
// ENV: NEXT_PUBLIC_ABLY_KEY must be set (Ably API key from dashboard).
// Falls back to polling if Ably is not configured.
// ====================================================================

export interface LiveAttendance {
  id: number;
  accountId: string;
  fullName: string;
  studentId: number | null;
  program: string | null;
  section: string | null;
  scannedAt: string;
  source: string;
}

export function useAttendanceSocket(eventId: number | null) {
  const [connected, setConnected] = useState(false);
  const [latest, setLatest] = useState<LiveAttendance | null>(null);
  const clientRef = useRef<Ably.Realtime | null>(null);

  useEffect(() => {
    const ablyKey = process.env.NEXT_PUBLIC_ABLY_KEY;
    if (!ablyKey || eventId == null) return;

    const client = new Ably.Realtime({ key: ablyKey, autoConnect: true });
    clientRef.current = client;

    const channel = client.channels.get(`event:${eventId}`);

    channel.subscribe("attendance", (msg) => {
      const payload = msg.data as LiveAttendance;
      setLatest(payload);
    });

    client.connection.on("connected", () => setConnected(true));
    client.connection.on("disconnected", () => setConnected(false));
    client.connection.on("suspended", () => setConnected(false));
    client.connection.on("failed", () => setConnected(false));
    // "closed" fires on explicit close() — suppress the uncaught rejection.
    client.connection.on("closed", () => setConnected(false));

    return () => {
      // Unsubscribe listeners BEFORE closing so the SDK doesn't try to
      // process events during shutdown (which causes uncaught rejections).
      channel.unsubscribe();
      client.connection.off();
      // close() returns a Promise that rejects with "Connection closed" —
      // catch it to suppress the console error (this is expected behavior).
      client.close().catch(() => {});
      clientRef.current = null;
      setConnected(false);
    };
  }, [eventId]);

  return { connected, latest };
}
