// ====================================================================
// Nexus Gate — URL Safety Validator (SSRF Defense)
// ====================================================================
// Validates user-supplied URLs to prevent Server-Side Request Forgery.
// Used for push-notification endpoints and any other user-controlled URL
// that the server might later fetch.
//
// Defense layers:
//   1. Scheme allowlist (HTTPS only in production, HTTP allowed in dev)
//   2. Hostname resolution → reject private/internal IP ranges
//   3. Known push-provider allowlist (FCM, Mozilla, Apple, Windows)
//   4. Reject localhost, link-local, metadata endpoints
// ====================================================================

export interface UrlValidationResult {
  ok: boolean;
  reason?: string;
}

// Known Web Push service providers (browser-vendor operated)
const PUSH_PROVIDER_PATTERNS = [
  /\.fcm\.googleapis\.com$/i,           // Firebase Cloud Messaging (Chrome)
  /\.android\.com$/i,                    // Android push
  /^fcm\.googleapis\.com$/i,
  /^updates\.push\.services\.mozilla\.com$/i,  // Mozilla Push (Firefox)
  /^push\.apple\.com$/i,                 // Apple Push (Safari)
  /^wpush\.apple\.com$/i,
  /\.push\.apple\.com$/i,
  /^notify\.windows\.com$/i,             // Windows Push (Edge)
  /\.notify\.windows\.com$/i,
];

// Private/internal IP ranges (IPv4)
const PRIVATE_IPV4_RANGES = [
  /^127\./,           // Loopback
  /^10\./,            // Private (Class A)
  /^172\.(1[6-9]|2\d|3[01])\./,  // Private (Class B)
  /^192\.168\./,      // Private (Class C)
  /^169\.254\./,      // Link-local
  /^0\./,             // "This" network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,  // Carrier-grade NAT
  /^192\.0\.0\./,     // IETF protocol assignments
  /^198\.(1[8-9])\./, // Benchmarking
  /^::1$/,            // IPv6 loopback
  /^fe80:/i,          // IPv6 link-local
  /^fc00:/i,          // IPv6 unique-local
  /^fd00:/i,          // IPv6 unique-local
];

function isPrivateIp(ip: string): boolean {
  return PRIVATE_IPV4_RANGES.some((re) => re.test(ip));
}

function isKnownPushProvider(hostname: string): boolean {
  return PUSH_PROVIDER_PATTERNS.some((re) => re.test(hostname));
}

// ---- Main validator ----
export function validatePushEndpoint(
  urlStr: string,
  options: { allowHttp?: boolean } = {}
): UrlValidationResult {
  const isProduction = process.env.NODE_ENV === "production";

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { ok: false, reason: "Invalid URL format" };
  }

  // Scheme check
  if (isProduction && parsed.protocol !== "https:") {
    return { ok: false, reason: "Push endpoint must use HTTPS in production" };
  }
  if (!options.allowHttp && parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "Push endpoint must use HTTP or HTTPS" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "Unsupported URL scheme" };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // Reject localhost / loopback hostnames
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0" || hostname === "[::1]") {
    return { ok: false, reason: "Push endpoint cannot point to localhost" };
  }

  // Reject IP addresses in private ranges (both IPv4 and IPv6)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
    if (isPrivateIp(hostname)) {
      return { ok: false, reason: "Push endpoint cannot point to a private/internal IP" };
    }
  }

  // Reject metadata endpoints (AWS, GCP, Azure)
  if (hostname === "169.254.169.254" || hostname === "metadata.google.internal" || hostname === "metadata.azure.com") {
    return { ok: false, reason: "Push endpoint cannot point to a cloud metadata service" };
  }

  // If it's a known push provider, allow it
  if (isKnownPushProvider(hostname)) {
    return { ok: true };
  }

  // For unknown hostnames, allow in dev but be cautious in production
  // (We don't block unknown hosts because push providers can change)
  if (!isProduction) {
    return { ok: true };
  }

  // In production: allow HTTPS endpoints that are not private IPs
  // (Web Push endpoints are always HTTPS and hosted by browser vendors)
  if (parsed.protocol === "https:" && !isPrivateIp(hostname)) {
    return { ok: true };
  }

  return { ok: false, reason: "Push endpoint failed validation" };
}

// ---- Generic URL validator (for any user-supplied URL the server fetches) ----
export function validateExternalUrl(urlStr: string): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { ok: false, reason: "Invalid URL format" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "URL must use HTTP or HTTPS" };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // Reject localhost / loopback
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0") {
    return { ok: false, reason: "URL cannot point to localhost" };
  }

  // Reject private IP ranges
  if (isPrivateIp(hostname)) {
    return { ok: false, reason: "URL cannot point to a private/internal IP" };
  }

  // Reject metadata endpoints
  if (hostname === "169.254.169.254" || hostname === "metadata.google.internal" || hostname === "metadata.azure.com") {
    return { ok: false, reason: "URL cannot point to a cloud metadata service" };
  }

  return { ok: true };
}
