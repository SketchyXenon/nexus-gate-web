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
    // Validate eventId with the SAME rules as the server route
    // (src/app/api/ably/token/route.ts). Catches null, undefined, 0,
    // NaN, negatives, and non-integers — all of which would produce a
    // 400 BAD_REQUEST from the token endpoint if we let them through.
    if (!Number.isInteger(eventId) || eventId <= 0) return;

    let cancelled = false;
    let cleanedUp = false;
    let client: Ably.Realtime | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let authFailed = false;

    // Ably's internal state machine can reject with "Connection closed"
    // when close() is called on a failed/closing connection. These rejections
    // have no .catch() inside the SDK and surface as uncaught promise
    // rejections. Swallow them during teardown so the console stays clean
    // and no error-tracking (Sentry) fires for expected teardown noise.
    const onUnhandledRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason;
      const msg =
        typeof reason === "string"
          ? reason
          : reason?.message || reason?.code || "";
      if (
        typeof msg === "string" &&
        (msg.includes("Connection closed") ||
          msg.includes("Ably auth aborted") ||
          msg.includes("token endpoint returned"))
      ) {
        e.preventDefault();
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("unhandledrejection", onUnhandledRejection);
    }

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (client) {
        try {
          const channel = client.channels.get(`event:${eventId}`);
          channel.unsubscribe();
          client.connection.off();
          // Only call close() if the connection is in a state where close
          // is meaningful. Calling close() on a "failed"/"closing"/"closed"
          // connection triggers Ably's internal requestState("closed") which
          // rejects with "Connection closed" and leaks as an uncaught promise.
          const state = client.connection.state;
          if (
            state === "initialized" ||
            state === "connecting" ||
            state === "connected" ||
            state === "disconnected" ||
            state === "suspended"
          ) {
            client.close();
          }
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
            // Defensive: re-validate eventId inside the callback too, since
            // the Ably SDK can call authCallback multiple times (renewal,
            // reconnection) and we want to guarantee a valid URL every time.
            if (!Number.isInteger(eventId) || eventId <= 0) {
              callback("Invalid eventId for Ably token request", null);
              return;
            }
            const res = await fetch(
              `/api/ably/token?eventId=${encodeURIComponent(eventId)}`,
            );
            // Re-check cancelled after the await: the effect may have torn
            // down while the fetch was in flight. Delivering a token to a
            // closing client causes Ably to throw internally.
            if (cancelled || cleanedUp) {
              callback("Ably auth aborted", null);
              return;
            }
            if (!res.ok) {
              authFailed = true;
              callback(`token endpoint returned ${res.status}`, null);
              return;
            }
            const token = await res.json();
            if (cancelled || cleanedUp) {
              callback("Ably auth aborted", null);
              return;
            }
            callback(null, token);
          } catch (e) {
            authFailed = true;
            callback(e instanceof Error ? e.message : "fetch failed", null);
          }
        },
      });
    } catch (e) {
      console.error("[useAttendanceSocket] Ably init failed:", e);
      if (typeof window !== "undefined") {
        window.removeEventListener("unhandledrejection", onUnhandledRejection);
      }
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
      if (typeof window !== "undefined") {
        window.removeEventListener("unhandledrejection", onUnhandledRejection);
      }
    };
  }, [eventId]);

  return { connected, latest };
}
