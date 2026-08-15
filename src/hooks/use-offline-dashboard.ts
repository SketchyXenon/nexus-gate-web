"use client";

import { useEffect, useState } from "react";
import {
  saveDashboardSnapshot,
  loadDashboardSnapshot,
  clearDashboardSnapshot,
  type DashboardSnapshot,
} from "@/lib/rxdb";

// ====================================================================
// useOfflineDashboard — RxDB-backed offline snapshot for the dashboard.
// --------------------------------------------------------------------
// Wraps the React Query result from useDashboard(). On success, persists
// the payload to RxDB (IndexedDB). When the query is loading AND the
// browser is offline, serves the last-known snapshot instead of an empty
// skeleton — the offline-first identity.
//
// Per 04-testing-methodology.md: the hook is a thin adapter; the RxDB
// store is unit-tested separately. This layer only orchestrates.
// ====================================================================

export function useOfflineDashboard<T>(
  accountId: string | undefined,
  queryData: T | undefined,
  isLoading: boolean,
  isError: boolean,
): { snapshot: DashboardSnapshot<T> | null; stale: boolean } {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot<T> | null>(null);
  const [stale, setStale] = useState(false);

  // Persist on successful query.
  useEffect(() => {
    if (queryData && accountId) {
      saveDashboardSnapshot(accountId, queryData).catch(() => {});
    }
  }, [accountId, queryData]);

  // When loading + offline, hydrate from RxDB.
  useEffect(() => {
    let mounted = true;
    if (!accountId) return;
    // Only hydrate when we have no fresh data (loading or error).
    if (!isLoading && !isError) {
      setStale(false);
      return;
    }
    loadDashboardSnapshot<T>(accountId)
      .then((snap) => {
        if (mounted && snap) {
          setSnapshot(snap);
          setStale(true);
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [accountId, isLoading, isError]);

  // Clear on unmount of the "session" — caller can call clearDashboardSnapshot
  // explicitly on logout (kept here for symmetry, not auto-invoked).
  return { snapshot, stale };
}

export { clearDashboardSnapshot };
