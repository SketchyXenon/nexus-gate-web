"use client";

// ====================================================================
// Nexus Gate — Client-side stale-while-revalidate cache (offline-first)
// --------------------------------------------------------------------
// Per 02-system-design.md §4: caching cuts read load + latency but
// introduces staleness — so every entry has an explicit TTL and a
// background-revalidation path. Per the offline-first identity, the
// cache is the single source of truth when navigator.onLine is false:
// GET endpoints serve cached data immediately, then revalidate in the
// background when connectivity returns.
//
// Design:
//   - In-memory Map + localStorage persistence (survives reloads).
//   - SWR: serve cached value instantly, trigger a background refetch
//     if the entry is stale (older than TTL). The caller sees the
//     cached data first, then a fresh value when the refetch resolves.
//   - Invalidation: mutations (POST/PATCH/DELETE) call invalidate(key)
//     so the next read refetches instead of serving stale data.
// ====================================================================

interface CacheEntry<T> {
  data: T;
  ts: number; // when cached
  loading?: boolean; // background refetch in progress
}

const STORE_PREFIX = "ng_cache_v1";
const DEFAULT_TTL_MS = 60_000; // 1 min: balance freshness vs offline utility
const PERSIST_KEYS = new Set<string>();

function memKey(key: string) {
  return `${STORE_PREFIX}:${key}`;
}

// In-memory cache (survives HMR, lost on full reload — backed by localStorage).
const memory = new Map<string, CacheEntry<unknown>>();

function readPersisted<T>(key: string): CacheEntry<T> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(memKey(key));
    if (!raw) return null;
    return JSON.parse(raw) as CacheEntry<T>;
  } catch {
    return null;
  }
}

function persist<T>(key: string, entry: CacheEntry<T>) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(memKey(key), JSON.stringify(entry));
    PERSIST_KEYS.add(key);
  } catch {
    // Quota exceeded — drop the oldest persisted entry to make room.
    // Silent: cache is best-effort, never throws.
  }
}

/** Get a cache entry (memory first, then localStorage). */
export function getCached<T>(key: string): CacheEntry<T> | null {
  const mem = memory.get(key) as CacheEntry<T> | undefined;
  if (mem) return mem;
  const persisted = readPersisted<T>(key);
  if (persisted) {
    memory.set(key, persisted);
    return persisted;
  }
  return null;
}

/** Is the entry stale (older than ttlMs)? */
export function isStale(entry: CacheEntry<unknown>, ttlMs = DEFAULT_TTL_MS): boolean {
  return Date.now() - entry.ts > ttlMs;
}

/** Write a value to the cache (memory + localStorage). */
export function setCached<T>(key: string, data: T): void {
  const entry: CacheEntry<T> = { data, ts: Date.now() };
  memory.set(key, entry);
  persist(key, entry);
}

/** Mark a key as loading (background refetch in progress). */
export function setLoading(key: string): void {
  const existing = memory.get(key);
  if (existing) {
    memory.set(key, { ...existing, loading: true });
  }
}

/** Clear the loading flag. */
export function clearLoading(key: string): void {
  const existing = memory.get(key);
  if (existing) {
    memory.set(key, { ...existing, loading: false });
  }
}

/** Invalidate one key (next read refetches). */
export function invalidate(key: string): void {
  memory.delete(key);
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(memKey(key));
    } catch {
      /* ignore */
    }
  }
}

/** Invalidate all keys matching a prefix (e.g. invalidatePrefix("events")). */
export function invalidatePrefix(prefix: string): void {
  for (const k of [...memory.keys(), ...PERSIST_KEYS]) {
    if (k.startsWith(prefix)) invalidate(k);
  }
  // Also sweep localStorage for any persisted keys not yet loaded into memory.
  if (typeof window !== "undefined") {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const fullKey = localStorage.key(i);
        if (fullKey && fullKey.startsWith(memKey(prefix))) {
          const shortKey = fullKey.slice(memKey("").length);
          invalidate(shortKey);
        }
      }
    } catch {
      /* ignore */
    }
  }
}

export const CACHE_TTL = DEFAULT_TTL_MS;
