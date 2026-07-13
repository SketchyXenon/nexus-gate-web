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

const QUEUE_KEY_PREFIX = "ng_scan_queue_v2"; // bumped from v1 (new certificate format)

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

// Account-scoped queue key prevents cross-account metadata leaks on shared
// devices. User A's pending scans are invisible to User B.
function queueKey(accountId: string | undefined): string {
  // Fallback to the legacy global key if no accountId (shouldn't happen in
  // the authed app, but keeps the hook callable without crashing).
  return accountId
    ? `${QUEUE_KEY_PREFIX}:${accountId}`
    : QUEUE_KEY_PREFIX;
}

function loadQueue(accountId: string | undefined): QueuedScan[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(queueKey(accountId));
    return raw ? (JSON.parse(raw) as QueuedScan[]) : [];
  } catch {
    return [];
  }
}

function saveQueue(q: QueuedScan[], accountId: string | undefined) {
  try {
    localStorage.setItem(queueKey(accountId), JSON.stringify(q));
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

export function useScanQueue(accountId?: string) {
  const [queue, setQueue] = useState<QueuedScan[]>([]);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onlineRef = useRef(true);
  // Ref breaks the circular dependency between drain ↔ scheduleDrain.
  const drainRef = useRef<() => Promise<void>>(async () => {});
  const accountIdRef = useRef(accountId);
  // Keep the ref in sync with the prop (must not mutate ref during render).
  useEffect(() => {
    accountIdRef.current = accountId;
  }, [accountId]);

  const persist = useCallback((next: QueuedScan[]) => {
    saveQueue(next, accountIdRef.current);
    setQueue(next);
  }, []);

  const drain = useCallback(async () => {
    if (!onlineRef.current) return;
    const current = loadQueue(accountIdRef.current).filter(
      (s) => s.status === "pending"
    );
    if (current.length === 0) {
      setSyncing(false);
      return;
    }
    setSyncing(true);
    for (const item of current) {
      const all = loadQueue(accountIdRef.current);
      const idx = all.findIndex((s) => s.id === item.id);
      if (idx < 0) continue;
      all[idx] = { ...all[idx], status: "syncing" };
      persist(all);
      try {
        const res = await submitScanCertificate(item.signedCertificate);
        const after = loadQueue(accountIdRef.current);
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
        const after = loadQueue(accountIdRef.current);
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
      const next = [item, ...loadQueue(accountIdRef.current)];
      persist(next);
      scheduleDrain(0);
      return item;
    },
    [persist, scheduleDrain]
  );

  const clearSynced = useCallback(() => {
    persist(loadQueue(accountIdRef.current).filter((s) => s.status !== "synced"));
  }, [persist]);

  const removeItem = useCallback(
    (id: string) => {
      persist(loadQueue(accountIdRef.current).filter((s) => s.id !== id));
    },
    [persist]
  );

  // Hydrate from localStorage on mount + subscribe to network events.
  useEffect(() => {
    // Reset any "syncing" items back to "pending". If the page was closed
    // mid-drain, those items are stuck forever (the drain filter only picks
    // "pending"). This recovers them so they get retried.
    const loaded = loadQueue(accountId);
    const hasStuck = loaded.some((s) => s.status === "syncing");
    if (hasStuck) {
      const recovered = loaded.map((s) =>
        s.status === "syncing" ? { ...s, status: "pending" as const } : s
      );
      saveQueue(recovered, accountId);
      // One-time hydration from localStorage — setState in effect is intentional.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQueue(recovered);
    } else {
      setQueue(loaded);
    }
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
  }, [accountId, scheduleDrain]);

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
