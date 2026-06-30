"use client";

// ====================================================================
// Nexus Gate — Offline-First Scan Queue (v8 — signed certificates)
// --------------------------------------------------------------------
// When a scan is detected, the SIGNED scan certificate is written
// directly to localStorage in <1ms. A background listener watches
// navigator.onLine; when connectivity returns, the queue is drained
// with exponential backoff + jitter.
//
// v8 changes:
//   - Queue items now store a SIGNED CERTIFICATE instead of a raw token.
//   - The certificate is cryptographically bound to the device, so
//     tampering with the queue breaks the signature → rejected by server.
//   - The idempotency key is derived deterministically from the
//     certificate (can't be regenerated to bypass dedup).
// ====================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { submitScanCertificate } from "@/lib/api-client";
import type { SignedCertificate } from "@/lib/scan-certificate";

const QUEUE_KEY = "ng_scan_queue_v2"; // bumped from v1 (new certificate format)

export interface QueuedScan {
  id: string;
  eventId: number;
  signedCertificate: SignedCertificate; // v8: signed certificate replaces raw token
  queuedAt: number;
  attempts: number;
  status: "pending" | "syncing" | "synced" | "failed";
  result?: { alreadyPresent?: boolean; action?: string; message?: string };
  error?: string;
}

function loadQueue(): QueuedScan[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedScan[]) : [];
  } catch {
    return [];
  }
}

function saveQueue(q: QueuedScan[]) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch {
    /* ignore quota */
  }
}

function jitter(base: number): number {
  return base + Math.floor(Math.random() * 500);
}

function backoffDelay(attempts: number): number {
  const base = Math.min(30_000, 1000 * Math.pow(2, attempts));
  return jitter(base);
}

export function useScanQueue() {
  const [queue, setQueue] = useState<QueuedScan[]>([]);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onlineRef = useRef(true);
  // Ref breaks the circular dependency between drain ↔ scheduleDrain.
  const drainRef = useRef<() => Promise<void>>(async () => {});

  const persist = useCallback((next: QueuedScan[]) => {
    saveQueue(next);
    setQueue(next);
  }, []);

  const drain = useCallback(async () => {
    if (!onlineRef.current) return;
    const current = loadQueue().filter(
      (s) => s.status === "pending"
    );
    if (current.length === 0) {
      setSyncing(false);
      return;
    }
    setSyncing(true);
    for (const item of current) {
      const all = loadQueue();
      const idx = all.findIndex((s) => s.id === item.id);
      if (idx < 0) continue;
      all[idx] = { ...all[idx], status: "syncing" };
      persist(all);
      try {
        const res = await submitScanCertificate(item.signedCertificate);
        const after = loadQueue();
        const i2 = after.findIndex((s) => s.id === item.id);
        if (i2 >= 0) {
          after[i2] = {
            ...after[i2],
            status: "synced",
            result: {
              alreadyPresent: res.alreadyPresent,
              action: res.action,
              message: res.message,
            },
            attempts: after[i2].attempts + 1,
          };
          persist(after);
        }
      } catch (e) {
        const after = loadQueue();
        const i2 = after.findIndex((s) => s.id === item.id);
        if (i2 >= 0) {
          const attempts = after[i2].attempts + 1;
          after[i2] = {
            ...after[i2],
            status: attempts >= 5 ? "failed" : "pending",
            attempts,
            error: e instanceof Error ? e.message : String(e),
          };
          persist(after);
        }
        // Exponential backoff + jitter, then retry remaining.
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(
          () => drainRef.current(),
          backoffDelay(item.attempts)
        );
        return;
      }
    }
    setSyncing(false);
  }, [persist]);

  // Keep the ref in sync so scheduleDrain always invokes the latest drain.
  useEffect(() => {
    drainRef.current = drain;
  }, [drain]);

  const scheduleDrain = useCallback((delay: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => drainRef.current(), delay);
  }, []);

  const enqueueSigned = useCallback(
    (eventId: number, signedCertificate: SignedCertificate) => {
      const item: QueuedScan = {
        id: crypto.randomUUID(),
        eventId,
        signedCertificate,
        queuedAt: Date.now(),
        attempts: 0,
        status: "pending",
      };
      const next = [item, ...loadQueue()];
      persist(next);
      scheduleDrain(0);
      return item;
    },
    [persist, scheduleDrain]
  );

  const clearSynced = useCallback(() => {
    persist(loadQueue().filter((s) => s.status !== "synced"));
  }, [persist]);

  const removeItem = useCallback(
    (id: string) => {
      persist(loadQueue().filter((s) => s.id !== id));
    },
    [persist]
  );

  // Hydrate from localStorage on mount + subscribe to network events.
  useEffect(() => {
    // One-time mount hydration from localStorage (client-only store).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQueue(loadQueue());
    setOnline(navigator.onLine);
    onlineRef.current = navigator.onLine;
    const onOnline = () => {
      setOnline(true);
      onlineRef.current = true;
      scheduleDrain(0);
    };
    const onOffline = () => {
      setOnline(false);
      onlineRef.current = false;
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [scheduleDrain]);

  // Kick off drain whenever queue changes and we're online.
  useEffect(() => {
    if (online && queue.some((s) => s.status === "pending")) {
      scheduleDrain(0);
    }
  }, [queue, online, scheduleDrain]);

  const pendingCount = queue.filter(
    (s) => s.status === "pending" || s.status === "failed" || s.status === "syncing"
  ).length;

  return {
    queue,
    online,
    syncing,
    pendingCount,
    enqueueSigned,
    drain,
    clearSynced,
    removeItem,
  };
}
