"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

// ====================================================================
// useAttendanceSocket — subscribes to a per-event live attendance room.
// --------------------------------------------------------------------
// Production: connects to NEXT_PUBLIC_REALTIME_URL (e.g. Render service)
// Sandbox: connects via the gateway: io("/socket.io/?XTransformPort=3003")
// Falls back to 4-second polling if the realtime service is down.
//
// RENDER FREE-TIER NOTE:
//   Render's free plan spins down services after 15 min of inactivity.
//   The first request after spin-down takes ~30s to wake the service.
//   WebSocket transport can't wake a sleeping service (the WS upgrade
//   fails immediately). So we start with "polling" (HTTP) to wake the
//   service, then let socket.io upgrade to WebSocket automatically.
//   This is why transports is ["polling", "websocket"] (polling first),
//   NOT ["websocket", "polling"].
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
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (eventId == null) return;

    const rawUrl = process.env.NEXT_PUBLIC_REALTIME_URL;
    // Strip trailing slash — socket.io-client adds "/socket.io/" itself.
    // A trailing slash on the base URL causes "//socket.io/" (double slash).
    const realtimeUrl = rawUrl ? rawUrl.replace(/\/+$/, "") : undefined;

    const socket = realtimeUrl
      ? io(realtimeUrl, {
          path: "/socket.io/",
          // Polling FIRST — wakes up sleeping Render free-tier services
          // via HTTP, then socket.io auto-upgrades to WebSocket.
          transports: ["polling", "websocket"],
          reconnection: true,
          reconnectionAttempts: Infinity, // keep trying (Render may sleep)
          reconnectionDelay: 2000,
          reconnectionDelayMax: 10000, // cap backoff at 10s
          timeout: 20000, // 20s connect timeout (Render cold start ~30s)
        })
      : io("/socket.io/?XTransformPort=3003", {
          transports: ["polling", "websocket"],
          reconnection: true,
          reconnectionAttempts: Infinity,
          reconnectionDelay: 2000,
          reconnectionDelayMax: 10000,
          timeout: 20000,
        });
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => setConnected(false));
    socket.emit("subscribe", `event:${eventId}`);
    socket.on("attendance", (payload: LiveAttendance) => {
      setLatest(payload);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [eventId]);

  return { connected, latest };
}
