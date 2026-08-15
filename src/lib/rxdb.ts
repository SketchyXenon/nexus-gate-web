"use client";

// ====================================================================
// Nexus Gate — RxDB offline snapshot store
// --------------------------------------------------------------------
// Per 02-system-design.md §3 (deliberate pattern choice) and Z.md (no
// external libraries unless absolutely necessary): RxDB is applied ONLY
// where its reactive-query + durable-IndexedDB properties add real value
// that the existing stores can't provide.
//
// Where RxDB is used:
//   - Offline dashboard snapshots. When a user reopens the app offline,
//     React Query's in-memory cache is gone — the dashboard would show an
//     empty skeleton. RxDB (IndexedDB-backed, reactive) serves the
//     last-known snapshot instantly, then revalidates when online.
//
// Where RxDB is NOT used (deliberate):
//   - Scan queue: stays on localStorage. Its synchronous <1ms write is a
//     correctness requirement (no lost scans on page-close); RxDB's async
//     IndexedDB writes would regress that guarantee.
//   - Device keypair: already on direct IndexedDB (minimal, works).
//   - Session tokens: HttpOnly cookies (JS-unreadable by design).
//
// Free tier: rxdb core + getRxStorageDexie (Apache-2.0). No premium
// features (encryption/replication) are used.
// ====================================================================

import { createRxDatabase, type RxDatabase, type RxCollection } from "rxdb";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";

// Dashboard payload is stored as a JSON STRING (not a nested object) so
// RxDB's schema validation only needs to assert "string" — the arbitrary
// shape of the /api/dashboard response doesn't need to be modeled in the
// RxDB schema. Parsed back to its original shape on read.
export interface DashboardSnapshotDoc {
  accountId: string;
  dataJson: string;
  cachedAt: number;
}

export interface DashboardSnapshot<T = unknown> {
  accountId: string;
  data: T;
  cachedAt: number;
}

type DashboardSnapshotCollection = RxCollection<DashboardSnapshotDoc>;

let dbPromise: Promise<
  RxDatabase<{ dashboard: DashboardSnapshotCollection }>
> | null = null;

function createDb() {
  return createRxDatabase<{ dashboard: DashboardSnapshotCollection }>({
    name: "nexus_gate_offline",
    storage: getRxStorageDexie(),
    eventReduce: true,
    ignoreDuplicate: true,
  });
}

/** Lazily create + memoize the singleton RxDB instance. */
export function getDb() {
  if (typeof window === "undefined") {
    // SSR guard — RxDB requires IndexedDB (browser only).
    return null;
  }
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await createDb();
      // Add the dashboard snapshots collection if it doesn't exist.
      if (!db.collections.dashboard) {
        await db.addCollections({
          dashboard: {
            schema: {
              version: 1,
              primaryKey: "accountId",
              type: "object",
              properties: {
                accountId: { type: "string", maxLength: 100 },
                dataJson: { type: "string", maxLength: 1_000_000 },
                cachedAt: { type: "number", minimum: 0 },
              },
              required: ["accountId", "dataJson", "cachedAt"],
              indexes: ["cachedAt"],
            },
          },
        });
      }
      return db;
    })();
  }
  return dbPromise;
}

/** Get the dashboard snapshot collection (or null on SSR/init failure). */
export async function getDashboardCollection(): Promise<DashboardSnapshotCollection | null> {
  const promise = getDb();
  if (!promise) return null;
  try {
    const db = await promise;
    return db.collections.dashboard;
  } catch {
    return null;
  }
}

/** Write/overwrite a snapshot for an account (upsert by accountId). */
export async function saveDashboardSnapshot(
  accountId: string,
  data: unknown,
): Promise<void> {
  const col = await getDashboardCollection();
  if (!col) return;
  try {
    await col.upsert({
      accountId,
      dataJson: JSON.stringify(data),
      cachedAt: Date.now(),
    });
  } catch {
    // Non-critical: offline cache is best-effort.
  }
}

/** Read the most recent snapshot for an account (or null). */
export async function loadDashboardSnapshot<T = unknown>(
  accountId: string,
): Promise<DashboardSnapshot<T> | null> {
  const col = await getDashboardCollection();
  if (!col) return null;
  try {
    const doc = await col.findOne(accountId).exec();
    if (!doc) return null;
    const json = doc.toMutableJSON() as DashboardSnapshotDoc;
    return {
      accountId: json.accountId,
      data: JSON.parse(json.dataJson) as T,
      cachedAt: json.cachedAt,
    };
  } catch {
    return null;
  }
}

/** Clear a snapshot (e.g. on logout). */
export async function clearDashboardSnapshot(accountId: string): Promise<void> {
  const col = await getDashboardCollection();
  if (!col) return;
  try {
    const doc = await col.findOne(accountId).exec();
    if (doc) await doc.remove();
  } catch {
    // Non-critical.
  }
}
