"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

// ====================================================================
// useAttendanceSocket — subscribes to a per-event live attendance room.
// --------------------------------------------------------------------
// Production: connects to NEXT_PUBLIC_REALTIME_URL (e.g. Render service)
// Sandbox: connects via the gateway: io("/socket.io/?XTransformPort=3003")
// Falls back to 4-second polling if the realtime service is down.
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

    const realtimeUrl = process.env.NEXT_PUBLIC_REALTIME_URL;
    const socket = realtimeUrl
      ? io(realtimeUrl, {
          path: "/socket.io/",
          transports: ["websocket", "polling"],
          reconnection: true,
          reconnectionAttempts: 5,
          reconnectionDelay: 2000,
        })
      : io("/socket.io/?XTransformPort=3003", {
          transports: ["websocket", "polling"],
          reconnection: true,
          reconnectionAttempts: 5,
          reconnectionDelay: 2000,
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
