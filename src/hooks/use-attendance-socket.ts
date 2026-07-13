"use client";

import { useEffect, useRef, useState } from "react";
import Ably from "ably";

// ====================================================================
// useAttendanceSocket — subscribes to a per-event live attendance channel.
// --------------------------------------------------------------------
// Uses Ably Token Authentication: the client fetches a short-lived,
// SUBSCRIBE-ONLY token from /api/ably/token. The full server key (which
// can publish) is NEVER shipped to the client. This prevents anyone from
// extracting a publish-capable key from the JS bundle to spam fake
// attendance events.
//
// Only organizers connect to Ably (students don't need realtime). Falls
// back to polling if the token endpoint is unavailable.
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
    if (eventId == null) return;

    let client: Ably.Realtime;
    try {
      // Token auth: the SDK calls /api/ably/token?eventId=N to get a signed,
      // subscribe-only TokenRequest scoped to THIS event's channel. No key
      // is shipped to the client, and the token can't subscribe to other
      // events' channels.
      client = new Ably.Realtime({
        authUrl: `/api/ably/token?eventId=${encodeURIComponent(eventId)}`,
        autoConnect: true,
      });
    } catch (e) {
      console.error("[useAttendanceSocket] Ably init failed:", e);
      return;
    }
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
      // close() returns void in the Ably SDK. The "Connection closed"
      // console error comes from Ably's internal Promise chain — removing
      // listeners before close prevents it from firing.
      client.close();
      clientRef.current = null;
      setConnected(false);
    };
  }, [eventId]);

  return { connected, latest };
}
