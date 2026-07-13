// ====================================================================
// Nexus Gate — URL Safety Validator (SSRF Defense)
// ====================================================================
// Validates user-supplied URLs to prevent Server-Side Request Forgery.
// Used for push-notification endpoints and any other user-controlled URL
// that the server might later fetch.
//
// Defense layers:
//   1. Scheme allowlist (HTTPS only in production, HTTP allowed in dev)
//   2. Hostname string checks (reject localhost, private IPs, metadata)
//   3. DNS resolution → reject if ANY resolved IP is private/internal
//      (closes the DNS rebinding attack: a hostname that resolves to a
//      private IP at request time)
//   4. Known push-provider allowlist (FCM, Mozilla, Apple, Windows)
// ====================================================================

import { lookup as dnsLookup, LookupAddress } from "node:dns";
import { promisify } from "node:util";

const dnsLookupAsync = promisify(dnsLookup);

export interface UrlValidationResult {
  ok: boolean;
  reason?: string;
}

// Known Web Push service providers (browser-vendor operated)
const PUSH_PROVIDER_PATTERNS = [
  /\.fcm\.googleapis\.com$/i,
  /\.android\.com$/i,
  /^fcm\.googleapis\.com$/i,
  /^updates\.push\.services\.mozilla\.com$/i,
  /^push\.apple\.com$/i,
  /^wpush\.apple\.com$/i,
  /\.push\.apple\.com$/i,
  /^notify\.windows\.com$/i,
  /\.notify\.windows\.com$/i,
];

// Private/internal IP ranges (IPv4 + IPv6)
const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^192\.0\.0\./,
  /^198\.(1[8-9])\./,
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
  /^fd00:/i,
  /^fd[0-9a-f]{2}:/i, // full fc00::/7 ULA range
];

function isPrivateIp(ip: string): boolean {
  // Normalize IPv4-mapped IPv6 (::ffff:1.2.3.4) to IPv4.
  const v4 = ip.replace(/^::ffff:/i, "");
  return PRIVATE_IP_PATTERNS.some((re) => re.test(v4) || re.test(ip));
}

function isKnownPushProvider(hostname: string): boolean {
  return PUSH_PROVIDER_PATTERNS.some((re) => re.test(hostname));
}

// Resolve a hostname and reject if ANY resolved IP is private/internal.
// This closes the DNS rebinding attack where a hostname resolves to a
// private IP at request time. Returns true if safe (no private IPs found).
async function isHostnameSafe(hostname: string): Promise<boolean> {
  let addrs: LookupAddress[];
  try {
    // all: true returns all A + AAAA records.
    addrs = await dnsLookupAsync(hostname, { all: true });
  } catch {
    // DNS resolution failed — treat as unsafe.
    return false;
  }
  if (addrs.length === 0) return false;
  for (const a of addrs) {
    if (isPrivateIp(a.address)) return false;
  }
  return true;
}

// ---- Main validator (async for DNS resolution) ----
export async function validatePushEndpoint(
  urlStr: string,
  options: { allowHttp?: boolean } = {}
): Promise<UrlValidationResult> {
  const isProduction = process.env.NODE_ENV === "production";

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { ok: false, reason: "Invalid URL format" };
  }

  // Scheme check.
  if (isProduction && parsed.protocol !== "https:") {
    return { ok: false, reason: "Push endpoint must use HTTPS in production" };
  }
  if (!options.allowHttp && parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "Push endpoint must use HTTP or HTTPS" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "Unsupported URL scheme" };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // Reject localhost / loopback hostnames.
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0" || hostname === "[::1]") {
    return { ok: false, reason: "Push endpoint cannot point to localhost" };
  }

  // Reject IP addresses in private ranges (string-level check first).
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
    if (isPrivateIp(hostname)) {
      return { ok: false, reason: "Push endpoint cannot point to a private/internal IP" };
    }
  }

  // Reject metadata endpoints.
  if (hostname === "169.254.169.254" || hostname === "metadata.google.internal" || hostname === "metadata.azure.com") {
    return { ok: false, reason: "Push endpoint cannot point to a cloud metadata service" };
  }

  // Known push providers are safe (browser-vendor operated).
  if (isKnownPushProvider(hostname)) {
    return { ok: true };
  }

  // In dev, allow unknown hosts without DNS resolution (faster iteration).
  if (!isProduction) {
    return { ok: true };
  }

  // In production: resolve the hostname and reject if any IP is private.
  // This closes the DNS rebinding attack.
  const safe = await isHostnameSafe(hostname);
  if (!safe) {
    return { ok: false, reason: "Push endpoint hostname resolves to a private/internal IP" };
  }

  return { ok: true };
}

// ---- Generic URL validator (async for DNS resolution) ----
export async function validateExternalUrl(urlStr: string): Promise<UrlValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { ok: false, reason: "Invalid URL format" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "URL must use HTTP or HTTPS" };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // Reject localhost / loopback.
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0") {
    return { ok: false, reason: "URL cannot point to localhost" };
  }

  // Reject private IP ranges (string-level).
  if (isPrivateIp(hostname)) {
    return { ok: false, reason: "URL cannot point to a private/internal IP" };
  }

  // Reject metadata endpoints.
  if (hostname === "169.254.169.254" || hostname === "metadata.google.internal" || hostname === "metadata.azure.com") {
    return { ok: false, reason: "URL cannot point to a cloud metadata service" };
  }

  // DNS resolution: reject if hostname resolves to a private IP.
  const safe = await isHostnameSafe(hostname);
  if (!safe) {
    return { ok: false, reason: "URL hostname resolves to a private/internal IP" };
  }

  return { ok: true };
}
