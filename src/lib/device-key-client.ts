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

import { canonicalizeCertificate, type ScanCertificate, type SignedCertificate } from "@/lib/scan-certificate";

const DB_NAME = "nexus_gate_device_keys";
const DB_VERSION = 1;
const STORE_NAME = "keys";
const KEY_RECORD_ID = "device_keypair";

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
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
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
  const hashBuffer = await crypto.subtle.digest("SHA-256", xBytes.buffer as ArrayBuffer);
  const hashBytes = new Uint8Array(hashBuffer);
  return Array.from(hashBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
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
 */
export async function generateDeviceKeyPair(): Promise<DeviceKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    "Ed25519",
    false, // not extractable as raw bytes (JWK only)
    ["sign", "verify"]
  );

  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const fingerprint = await computeFingerprint(publicKeyJwk);

  const deviceKeyPair: DeviceKeyPair = {
    publicKeyJwk,
    privateKeyJwk,
    fingerprint,
    registered: false,
  };

  await idbSet(KEY_RECORD_ID, deviceKeyPair);
  return deviceKeyPair;
}

/**
 * Get the stored device keypair, or generate a new one if none exists.
 * This is the main entry point for the scanner — call this before
 * creating a scan certificate.
 */
export async function getOrCreateDeviceKeyPair(): Promise<DeviceKeyPair> {
  const existing = await idbGet<DeviceKeyPair>(KEY_RECORD_ID);
  if (existing) return existing;
  return generateDeviceKeyPair();
}

/**
 * Mark the stored keypair as registered with the server.
 */
export async function markDeviceKeyRegistered(): Promise<void> {
  const existing = await idbGet<DeviceKeyPair>(KEY_RECORD_ID);
  if (existing) {
    existing.registered = true;
    await idbSet(KEY_RECORD_ID, existing);
  }
}

/**
 * Get the device fingerprint (hash of the public key).
 * Returns null if no keypair exists.
 */
export async function getDeviceFingerprint(): Promise<string | null> {
  const keyPair = await idbGet<DeviceKeyPair>(KEY_RECORD_ID);
  return keyPair?.fingerprint ?? null;
}

// ====================================================================
// Certificate Signing (Ed25519 via Web Crypto)
// ====================================================================

/**
 * Sign a scan certificate with the device's Ed25519 private key.
 *
 * @param cert - the unsigned scan certificate
 * @returns the signed certificate (certificate + canonical JSON + signature)
 */
export async function signCertificate(cert: ScanCertificate): Promise<SignedCertificate> {
  const keyPair = await getOrCreateDeviceKeyPair();

  // Import the private key for signing
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    keyPair.privateKeyJwk,
    "Ed25519",
    false,
    ["sign"]
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
 */
export async function registerDeviceKeyWithServer(label?: string): Promise<boolean> {
  const keyPair = await getOrCreateDeviceKeyPair();
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

    await markDeviceKeyRegistered();
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
