"use client";

import { useEffect, useRef, useState } from "react";
import Ably from "ably";

// ====================================================================
// useAttendanceSocket — subscribes to a per-event live attendance channel.
// --------------------------------------------------------------------
// Uses Ably Token Authentication. If Ably is not configured or the key
// is invalid, the hook falls back to polling silently.
//
// The hook has 3 layers of error handling:
// 1. Pre-flight token check: if /api/ably/token returns an error, skip Ably
// 2. Connection failure: if the Ably connection enters "failed" state,
//    close the client immediately to stop SDK retries
// 3. Connection timeout: if the connection doesn't connect within 10s,
//    close and fall back to polling
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
          // ignore cleanup errors
        }
        clientRef.current = null;
        client = null;
      }
    };

    // Pre-flight: check if the token endpoint is available.
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
            // Stop retrying after 2 attempts — if Ably is down or the key
            // is invalid, fall back to polling instead of spamming retries.
            auth: { retryCount: 2 },
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
        // On "failed" (e.g. invalid Ably key, 404): close immediately to
        // stop the SDK's internal retry loop. Fall back to polling.
        client.connection.on("failed", () => {
          console.warn(
            "[useAttendanceSocket] Ably connection failed, falling back to polling",
          );
          cleanup();
          setConnected(false);
        });
        client.connection.on("closed", () => setConnected(false));
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn(
            "[useAttendanceSocket] Ably unavailable, using polling:",
            e,
          );
        }
      });

    return () => {
      cancelled = true;
      cleanup();
      setConnected(false);
    };
  }, [eventId]);

  return { connected, latest };
}
