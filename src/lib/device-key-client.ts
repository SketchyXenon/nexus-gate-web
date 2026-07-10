"use client";

// ====================================================================
// Nexus Gate — Device Key Management (CLIENT-SIDE)
// --------------------------------------------------------------------
// Each student's device has an Ed25519 keypair. The PRIVATE key lives
// only on the device (IndexedDB). The PUBLIC key is registered with
// the server.
//
// Scan certificates are signed by the device's private key and verified
// by the server against the registered public key.
//
// Why Ed25519?
//   - Fast signing/verification (sub-millisecond)
//   - Small keys (32 bytes public, 32 bytes private)
//   - Small signatures (64 bytes)
//   - Supported by Web Crypto API in modern browsers (Chrome 113+,
//     Safari 17+, Firefox 130+)
//   - Supported by Node.js crypto module (server-side)
//
// Storage: IndexedDB (not localStorage) because:
//   - More tamper-resistant (not trivially editable via DevTools)
//   - Persists across sessions
//   - Can store larger binary payloads
//   - Asynchronous API (doesn't block the main thread)
// ====================================================================

import {
  canonicalizeCertificate,
  type ScanCertificate,
  type SignedCertificate,
} from "@/lib/scan-certificate";

const DB_NAME = "nexus_gate_device_keys";
const DB_VERSION = 2;
const STORE_NAME = "keys";

/**
 * Build the IndexedDB key for a given account.
 * Scoped by accountId so that a shared device (library tablet) doesn't
 * reuse one student's key for another student's scans.
 */
function keyRecordId(accountId: string): string {
  return `device_keypair:${accountId}`;
}

// ---- Types ----

export interface DeviceKeyPair {
  /** Ed25519 public key as JWK (JSON Web Key) */
  publicKeyJwk: JsonWebKey;
  /** Ed25519 private key as JWK (JSON Web Key) */
  privateKeyJwk: JsonWebKey;
  /** SHA-256 fingerprint of the public key (hex) */
  fingerprint: string;
  /** Whether this keypair has been registered with the server */
  registered: boolean;
}

// ====================================================================
// IndexedDB helpers
// ====================================================================

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      // v1 → v2: no schema change to the store itself (keys are just strings).
      // Old keys ("device_keypair") are orphaned and will be cleaned up by
      // the browser's IndexedDB eviction — they're not reused.
      if (event.oldVersion < 1) {
        // First install — nothing extra to do.
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ====================================================================
// Ed25519 Keypair Management (Web Crypto API)
// ====================================================================

/**
 * Compute the SHA-256 fingerprint of a public key JWK.
 * The fingerprint is a hex string derived from the JWK's `x` property
 * (the raw public key bytes in base64url).
 */
async function computeFingerprint(publicKeyJwk: JsonWebKey): Promise<string> {
  // The JWK `x` field is the raw Ed25519 public key (32 bytes) in base64url.
  // We hash that to get a stable fingerprint.
  const xBytes = base64UrlToBytes(publicKeyJwk.x!);
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    xBytes.buffer as ArrayBuffer,
  );
  const hashBytes = new Uint8Array(hashBuffer);
  return Array.from(hashBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(b64 + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Generate a new Ed25519 keypair and store it in IndexedDB.
 * Returns the keypair + fingerprint. Does NOT register with the server
 * (call registerDeviceKeyWithServer() for that).
 *
 * SECURITY NOTE on extractable=true:
 *   WebCrypto requires extractable=true to call exportKey("jwk", ...).
 *   We need the JWK form to (a) store it in IndexedDB for later signing
 *   and (b) send the public key JWK to the server for registration.
 *
 *   The private key JWK never leaves the device — it's only stored in
 *   IndexedDB (same-origin) and re-imported for each signing operation.
 *   It is NEVER sent to the server or exposed to JavaScript from other
 *   origins. This is the standard pattern for client-side key storage
 *   when using the JWK format.
 *
 *   The previous code used extractable=false, which caused:
 *     "Failed to execute 'exportKey' on 'SubtleCrypto': key is not extractable"
 *   on every scan attempt (the scanner couldn't sign certificates).
 */
export async function generateDeviceKeyPair(
  accountId: string,
): Promise<DeviceKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    "Ed25519",
    true, // extractable — required to export JWK for IndexedDB storage
    ["sign", "verify"],
  );

  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey(
    "jwk",
    keyPair.privateKey,
  );
  const fingerprint = await computeFingerprint(publicKeyJwk);

  const deviceKeyPair: DeviceKeyPair = {
    publicKeyJwk,
    privateKeyJwk,
    fingerprint,
    registered: false,
  };

  await idbSet(keyRecordId(accountId), deviceKeyPair);
  return deviceKeyPair;
}

/**
 * Get the stored device keypair, or generate a new one if none exists.
 * Scoped by accountId so shared devices don't cross-contaminate keys.
 *
 * If the stored keypair is missing the JWK fields (corrupt state from
 * a previous bug), it's regenerated. This ensures the scanner never
 * gets stuck with an unusable key.
 */
export async function getOrCreateDeviceKeyPair(
  accountId: string,
): Promise<DeviceKeyPair> {
  const existing = await idbGet<DeviceKeyPair>(keyRecordId(accountId));
  // Validate the stored keypair has the required JWK fields.
  if (existing && existing.publicKeyJwk?.x && existing.privateKeyJwk?.d) {
    return existing;
  }
  // Corrupt or missing — regenerate.
  return generateDeviceKeyPair(accountId);
}

/**
 * Mark the stored keypair as registered with the server.
 */
export async function markDeviceKeyRegistered(
  accountId: string,
): Promise<void> {
  const existing = await idbGet<DeviceKeyPair>(keyRecordId(accountId));
  if (existing) {
    existing.registered = true;
    await idbSet(keyRecordId(accountId), existing);
  }
}

/**
 * Get the device fingerprint (hash of the public key) for a given account.
 * Returns null if no keypair exists.
 */
export async function getDeviceFingerprint(
  accountId: string,
): Promise<string | null> {
  const keyPair = await idbGet<DeviceKeyPair>(keyRecordId(accountId));
  return keyPair?.fingerprint ?? null;
}

// ====================================================================
// Certificate Signing (Ed25519 via Web Crypto)
// ====================================================================

/**
 * Sign a scan certificate with the device's Ed25519 private key.
 *
 * @param cert - the unsigned scan certificate
 * @param accountId - the logged-in user's account ID (for key scoping)
 * @returns the signed certificate (certificate + canonical JSON + signature)
 */
export async function signCertificate(
  cert: ScanCertificate,
  accountId: string,
): Promise<SignedCertificate> {
  const keyPair = await getOrCreateDeviceKeyPair(accountId);

  // Import the private key for signing
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    keyPair.privateKeyJwk,
    "Ed25519",
    false,
    ["sign"],
  );

  // Canonicalize the certificate (deterministic JSON)
  const canonical = canonicalizeCertificate(cert);
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);

  // Sign (Ed25519 has no algorithm-specific parameters — pass null)
  const signatureBuffer = await crypto.subtle.sign("Ed25519", privateKey, data);
  const signature = bytesToBase64(new Uint8Array(signatureBuffer));

  return { certificate: cert, canonical, signature };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ====================================================================
// Server Registration
// ====================================================================

/**
 * Register the device's public key with the server.
 * Called after login (or on first scan) if the key isn't yet registered.
 *
 * @param accountId - the logged-in user's account ID (for key scoping)
 * @param label - optional device label
 */
export async function registerDeviceKeyWithServer(
  accountId: string,
  label?: string,
): Promise<boolean> {
  const keyPair = await getOrCreateDeviceKeyPair(accountId);
  if (keyPair.registered) return true;

  try {
    const res = await fetch("/api/profile/device-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKeyJwk: keyPair.publicKeyJwk,
        fingerprint: keyPair.fingerprint,
        label: label ?? getDeviceLabel(),
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error("Device key registration failed:", data);
      return false;
    }

    await markDeviceKeyRegistered(accountId);
    return true;
  } catch (e) {
    console.error("Device key registration error:", e);
    return false;
  }
}

/**
 * Get a human-readable device label (e.g. "iPhone", "Chrome on Windows").
 */
function getDeviceLabel(): string {
  if (typeof navigator === "undefined") return "Unknown";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "Unknown";
}
