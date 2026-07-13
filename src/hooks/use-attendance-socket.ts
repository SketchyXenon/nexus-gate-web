"use client";

import { useEffect, useRef, useState } from "react";
import Ably from "ably";

// ====================================================================
// useAttendanceSocket — subscribes to a per-event live attendance channel.
// --------------------------------------------------------------------
// Uses Ably Token Authentication: the client fetches a short-lived,
// SUBSCRIBE-ONLY token from /api/ably/token. The full server key (which
// can publish) is NEVER shipped to the client.
//
// If the token endpoint returns an error (e.g. Ably not configured, or
// the ABLY_SERVER_KEY is invalid), the hook skips the Ably connection
// entirely and falls back to polling (the caller's presenceQ polling).
// This prevents the "Connection closed" uncaught rejection that occurred
// when the Ably SDK tried to submit a token request to a non-existent app.
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

    let cancelled = false;
    let client: Ably.Realtime | null = null;

    // First, check if the token endpoint is available and returns a valid
    // token. If it returns an error (503 = not configured, 500 = misconfigured,
    // 400 = bad eventId), skip the Ably connection entirely.
    fetch(`/api/ably/token?eventId=${encodeURIComponent(eventId)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`token endpoint returned ${res.status}`);
        return res.json();
      })
      .then(() => {
        if (cancelled) return;
        try {
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
        client.connection.on("closed", () => setConnected(false));
      })
      .catch((e) => {
        // Token endpoint failed — Ably is not configured or misconfigured.
        // Silently fall back to polling (the caller's presenceQ).
        if (!cancelled) {
          console.warn(
            "[useAttendanceSocket] Ably unavailable, using polling:",
            e,
          );
        }
      });

    return () => {
      cancelled = true;
      if (client) {
        try {
          const channel = client.channels.get(`event:${eventId}`);
          channel.unsubscribe();
          client.connection.off();
          client.close();
        } catch {
          // ignore cleanup errors
        }
        clientRef.current = null;
      }
      setConnected(false);
    };
  }, [eventId]);

  return { connected, latest };
}
