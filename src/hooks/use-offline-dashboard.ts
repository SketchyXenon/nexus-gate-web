"use client";

import { useEffect, useState } from "react";
import {
  saveDashboardSnapshot,
  loadDashboardSnapshot,
  clearDashboardSnapshot,
  type DashboardSnapshot,
} from "@/lib/rxdb";

// ====================================================================
// useOfflineDashboard - RxDB-backed offline snapshot for the dashboard.
// --------------------------------------------------------------------
// Wraps the React Query result from useDashboard(). On success, persists
// the payload to RxDB (IndexedDB). When the query is loading AND the
// browser is offline, serves the last-known snapshot instead of an empty
// skeleton - the offline-first identity.
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
      return;
    }
    loadDashboardSnapshot<T>(accountId)
      .then((snap) => {
        if (mounted && snap) {
          setSnapshot(snap);
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [accountId, isLoading, isError]);

  // Derive "stale" during render instead of tracking it as separate state
  // (which would require a synchronous setStale(false) inside the effect
  // when fresh data is present - a cascading setState). stale is true only
  // when we're serving the offline snapshot during loading/error.
  const stale = (!!isLoading || isError) && snapshot !== null;

  // Clear on unmount of the "session" - caller can call clearDashboardSnapshot
  // explicitly on logout (kept here for symmetry, not auto-invoked).
  return { snapshot, stale };
}

export { clearDashboardSnapshot };
