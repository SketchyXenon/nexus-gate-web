"use client";

import { useEffect, useRef, useState } from "react";
import Ably from "ably";

// ====================================================================
// useAttendanceSocket — subscribes to a per-event live attendance channel.
// --------------------------------------------------------------------
// Uses Ably Token Authentication via authCallback (not authUrl). This
// gives us full control over error handling: if the token endpoint
// returns an error or the Ably key is invalid, we reject the auth
// callback BEFORE the SDK starts its internal retry loop.
//
// If Ably is unavailable, the hook falls back to polling silently.
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

const CONNECT_TIMEOUT_MS = 10_000;

export function useAttendanceSocket(eventId: number | null) {
  const [connected, setConnected] = useState(false);
  const [latest, setLatest] = useState<LiveAttendance | null>(null);
  const clientRef = useRef<Ably.Realtime | null>(null);

  useEffect(() => {
    if (eventId == null) return;

    let cancelled = false;
    let client: Ably.Realtime | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let authFailed = false;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (client) {
        try {
          const channel = client.channels.get(`event:${eventId}`);
          channel.unsubscribe();
          client.connection.off();
          client.close();
        } catch {
          // ignore
        }
        clientRef.current = null;
        client = null;
      }
    };

    // Use authCallback instead of authUrl. This lets us catch errors
    // before the SDK starts its internal retry loop.
    try {
      client = new Ably.Realtime({
        autoConnect: false,
        authCallback: async (_data, callback) => {
          if (cancelled || authFailed) {
            callback("Ably auth aborted", null);
            return;
          }
          try {
            const res = await fetch(
              `/api/ably/token?eventId=${encodeURIComponent(eventId)}`,
            );
            if (!res.ok) {
              authFailed = true;
              callback(`token endpoint returned ${res.status}`, null);
              return;
            }
            const token = await res.json();
            callback(null, token);
          } catch (e) {
            authFailed = true;
            callback(e instanceof Error ? e.message : "fetch failed", null);
          }
        },
      });
    } catch (e) {
      console.error("[useAttendanceSocket] Ably init failed:", e);
      return;
    }

    clientRef.current = client;

    // Timeout: if not connected within 10s, close and fall back.
    timeoutId = setTimeout(() => {
      if (client && client.connection.state !== "connected") {
        console.warn(
          "[useAttendanceSocket] Connection timeout, falling back to polling",
        );
        cleanup();
        setConnected(false);
      }
    }, CONNECT_TIMEOUT_MS);

    const channel = client.channels.get(`event:${eventId}`);

    channel.subscribe("attendance", (msg) => {
      const payload = msg.data as LiveAttendance;
      setLatest(payload);
    });

    client.connection.on("connected", () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      setConnected(true);
    });
    client.connection.on("disconnected", () => setConnected(false));
    client.connection.on("suspended", () => setConnected(false));
    client.connection.on("failed", () => {
      console.warn(
        "[useAttendanceSocket] Ably connection failed, falling back to polling",
      );
      cleanup();
      setConnected(false);
    });
    client.connection.on("closed", () => setConnected(false));

    // Connect after all listeners are registered.
    client.connect();

    return () => {
      cancelled = true;
      cleanup();
      setConnected(false);
    };
  }, [eventId]);

  return { connected, latest };
}
