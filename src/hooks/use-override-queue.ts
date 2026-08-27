"use client";

// ====================================================================
// Nexus Gate - Offline-First Override Queue (v16)
// --------------------------------------------------------------------
// When an organizer creates a manual override, the SIGNED override
// certificate is written to localStorage in <1ms. If the device is
// online it syncs immediately; offline entries drain automatically
// when connectivity returns (navigator.onLine listener) with
// exponential backoff + jitter.
//
// Mirrors use-scan-queue.ts (the proven student scan queue), with one
// addition: status-aware error classification. The api() client throws
// errors carrying .status/.code, letting the queue distinguish:
//   - 2xx                     -> synced
//   - 409 ALREADY_OVERRIDDEN  -> synced (idempotent duplicate: the entry
//                                already exists server-side, e.g. it was
//                                synced by an earlier attempt)
//   - 400/401/403/404         -> TERMINAL (tampering, window closed,
//                                ownership, eligibility - retrying can
//                                never succeed; surface the error in UI)
//   - 429 / 5xx / network     -> retry with backoff (max 5 attempts)
//
// Every queued item stores only the SIGNED certificate (+ display
// metadata). Editing any field of a queued item breaks the Ed25519
// signature, so the queue is tamper-evident end-to-end.
// ====================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { submitOverrideCertificate } from "@/lib/api-client";
import type { SignedOverrideCertificate } from "@/lib/override-certificate";

const QUEUE_KEY_PREFIX = "ng_override_queue_v1";
const MAX_ATTEMPTS = 5;

export interface QueuedOverride {
  id: string;
  /** Signed certificate - the tamper-evident source of truth */
  signed: SignedOverrideCertificate;
  /** Display metadata (NOT trusted server-side - the certificate is) */
  eventTitle: string;
  studentName: string;
  queuedAt: number;
  attempts: number;
  status: "pending" | "syncing" | "synced" | "failed";
  result?: { message?: string; offline?: boolean; alreadyOverridden?: boolean };
  error?: string;
}

// Account-scoped queue key prevents cross-account metadata leaks on shared
// devices (same pattern as the scan queue).
function queueKey(accountId: string | undefined): string {
  return accountId
    ? `${QUEUE_KEY_PREFIX}:${accountId}`
    : QUEUE_KEY_PREFIX;
}

function loadQueue(accountId: string | undefined): QueuedOverride[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(queueKey(accountId));
    return raw ? (JSON.parse(raw) as QueuedOverride[]) : [];
  } catch {
    return [];
  }
}

function saveQueue(q: QueuedOverride[], accountId: string | undefined) {
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

/**
 * Classify a submission error as retryable or terminal.
 * See the header comment for the full decision table.
 */
function isRetryable(e: unknown): boolean {
  const status = (e as { status?: number } | null)?.status;
  if (status == null) return true; // network error (fetch TypeError)
  if (status === 429) return true; // rate limited - wait and retry
  if (status >= 500) return true; // server error - transient
  return false; // 4xx (except 429 handled above): terminal
}

function isAlreadyOverridden(e: unknown): boolean {
  return (e as { status?: number; code?: string } | null)?.status === 409;
}

export function useOverrideQueue(accountId?: string) {
  const [queue, setQueue] = useState<QueuedOverride[]>([]);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onlineRef = useRef(true);
  // Ref breaks the circular dependency between drain ↔ scheduleDrain.
  const drainRef = useRef<() => Promise<void>>(async () => {});
  const accountIdRef = useRef(accountId);
  const qc = useQueryClient();

  // Keep the ref in sync with the prop (must not mutate ref during render).
  useEffect(() => {
    accountIdRef.current = accountId;
  }, [accountId]);

  const persist = useCallback((next: QueuedOverride[]) => {
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
        const res = await submitOverrideCertificate(item.signed);
        const after = loadQueue(accountIdRef.current);
        const i2 = after.findIndex((s) => s.id === item.id);
        if (i2 >= 0) {
          after[i2] = {
            ...after[i2],
            status: "synced",
            result: {
              message: res.message ?? "Student marked as present.",
              offline: res.offline,
            },
            attempts: after[i2].attempts + 1,
          };
          persist(after);
        }
        // The synced entry changed server-side data - refresh the
        // overrides list, rosters, and dashboard aggregates.
        qc.invalidateQueries({ queryKey: ["overrides"] });
        qc.invalidateQueries({ queryKey: ["attendance"] });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
      } catch (e) {
        // 409 ALREADY_OVERRIDDEN is an idempotent SUCCESS: the entry
        // already exists server-side (e.g. synced by an earlier attempt
        // or created by another organizer/admin).
        if (isAlreadyOverridden(e)) {
          const after = loadQueue(accountIdRef.current);
          const i2 = after.findIndex((s) => s.id === item.id);
          if (i2 >= 0) {
            after[i2] = {
              ...after[i2],
              status: "synced",
              result: {
                message: "Already recorded - the student already has an entry for this event.",
                alreadyOverridden: true,
              },
              attempts: after[i2].attempts + 1,
            };
            persist(after);
          }
          continue;
        }

        const message = e instanceof Error ? e.message : String(e);
        const after = loadQueue(accountIdRef.current);
        const i2 = after.findIndex((s) => s.id === item.id);
        if (i2 >= 0) {
          const attempts = after[i2].attempts + 1;
          // Terminal errors (validation/ownership/window/tamper) fail
          // immediately; retryable errors (network/5xx/429) back off up
          // to MAX_ATTEMPTS.
          const retry = isRetryable(e);
          after[i2] = {
            ...after[i2],
            status: retry && attempts < MAX_ATTEMPTS ? "pending" : "failed",
            attempts,
            error: message,
          };
          persist(after);
        }
        if (!isRetryable(e)) {
          // Terminal - continue draining the remaining items.
          continue;
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
  }, [persist, qc]);

  // Keep the ref in sync so scheduleDrain always invokes the latest drain.
  useEffect(() => {
    drainRef.current = drain;
  }, [drain]);

  const scheduleDrain = useCallback((delay: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => drainRef.current(), delay);
  }, []);

  const enqueueSigned = useCallback(
    (
      signed: SignedOverrideCertificate,
      meta: { eventTitle: string; studentName: string }
    ) => {
      const item: QueuedOverride = {
        id: crypto.randomUUID(),
        signed,
        eventTitle: meta.eventTitle,
        studentName: meta.studentName,
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

  const retryItem = useCallback(
    (id: string) => {
      const all = loadQueue(accountIdRef.current);
      const idx = all.findIndex((s) => s.id === id);
      if (idx < 0) return;
      all[idx] = { ...all[idx], status: "pending", attempts: 0, error: undefined };
      persist(all);
      scheduleDrain(0);
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
    // mid-drain, those items would be stuck forever. This recovers them.
    const loaded = loadQueue(accountId);
    const hasStuck = loaded.some((s) => s.status === "syncing");
    if (hasStuck) {
      const recovered = loaded.map((s) =>
        s.status === "syncing" ? { ...s, status: "pending" as const } : s
      );
      saveQueue(recovered, accountId);
      // One-time hydration from localStorage - setState in effect is
      // intentional.
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
    retryItem,
    drain,
    clearSynced,
    removeItem,
  };
}
