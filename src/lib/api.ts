// ====================================================================
// Nexus Gate — API Helpers
// Unified error responses, RBAC enforcement, request parsing.
// ====================================================================

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentAccount } from "@/lib/session";
import { hasMinimumRole, type Role } from "@/lib/rbac";
import { rateLimit } from "@/lib/rate-limit";

export interface ApiAccount {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  status: string;
  studentId: number | null;
  program: string | null;
  section: string | null;
  organizationName: string | null;
  year: number | null;
  lastLoginAt: string | null;
}

export async function getApiAccount(): Promise<ApiAccount | null> {
  const account = await getCurrentAccount();
  if (!account) return null;
  return { ...account, role: account.role as Role };
}

// ---- Error responses (consistent shape) ----
export function unauthorized(message = "Please sign in to continue") {
  return NextResponse.json(
    { error: message, code: "UNAUTHORIZED" },
    { status: 401 },
  );
}

export function forbidden(
  message = "You do not have permission to do this",
  code = "FORBIDDEN",
) {
  return NextResponse.json({ error: message, code }, { status: 403 });
}

export function badRequest(message: string, code = "BAD_REQUEST") {
  return NextResponse.json({ error: message, code }, { status: 400 });
}

export function notFound(message = "Not found") {
  return NextResponse.json(
    { error: message, code: "NOT_FOUND" },
    { status: 404 },
  );
}

export function conflict(message: string, code = "CONFLICT") {
  return NextResponse.json({ error: message, code }, { status: 409 });
}

export function tooManyRequests(retryAfterMs: number) {
  return NextResponse.json(
    {
      error: "Too many requests. Please slow down.",
      code: "RATE_LIMITED",
      retryAfterMs,
    },
    { status: 429 },
  );
}

// ---- Database unavailability detection ----
// PrismaClientInitializationError → can't connect to the DB (wrong creds,
//   unreachable, TLS) — infrastructure issue.
// PrismaClientRustPanicError → Prisma engine crashed — infrastructure.
// PrismaClientUnknownRequestError → query execution failed. When the
//   message contains "42P05" / "prepared statement ... already exists",
//   it's the Supabase pooler (Supavisor/PgBouncer transaction mode)
//   conflicting with Prisma's prepared statements — infrastructure, NOT
//   a code bug. The fix is adding ?pgbouncer=true to DATABASE_URL.
// All of these should surface as 503, not 500.
export function isDbUnavailableError(e: unknown): boolean {
  if (e instanceof Error) {
    return (
      e.name === "PrismaClientInitializationError" ||
      e.name === "PrismaClientRustPanicError" ||
      e.name === "PrismaClientUnknownRequestError"
    );
  }
  return false;
}

// Returns a 503 for DB failures. Logs the real error server-side for
// operators; returns a generic message to the client (no architecture leak).
export function dbUnavailable(e?: unknown) {
  const errName = e instanceof Error ? e.name : "Unknown";
  const errMsg = e instanceof Error ? e.message : "";
  console.error("[db] error:", errName, errMsg);
  return NextResponse.json(
    {
      error: "Service temporarily unavailable. Please try again in a moment.",
      code: "DB_UNAVAILABLE",
    },
    { status: 503 },
  );
}

// ---- Maintenance mode check ----
// Caches the maintenance setting for 10 seconds to avoid hitting the DB
// on every request. When maintenance is ON, non-admin users are blocked.
// Includes a stampede guard: concurrent requests at TTL boundary share a
// single in-flight DB query (prevents N concurrent requests from issuing
// N simultaneous DB queries when the cache expires).
let maintenanceCache: { value: boolean; expiresAt: number } | null = null;
let maintenanceInFlight: Promise<boolean> | null = null;

async function isMaintenanceMode(): Promise<boolean> {
  if (maintenanceCache && Date.now() < maintenanceCache.expiresAt) {
    return maintenanceCache.value;
  }
  // Stampede guard: if a query is already in-flight, await it instead of
  // issuing a duplicate.
  if (maintenanceInFlight) return maintenanceInFlight;
  maintenanceInFlight = (async () => {
    try {
      const { db } = await import("@/lib/db");
      const setting = await db.setting.findUnique({
        where: { key: "maintenance_mode" },
      });
      const value = setting?.value === "true";
      maintenanceCache = { value, expiresAt: Date.now() + 10_000 };
      return value;
    } catch {
      // Fail CLOSED on DB error: if we can't check maintenance status, treat
      // the system as in maintenance. This prevents a DB outage from silently
      // disabling the maintenance gate.
      return true;
    } finally {
      maintenanceInFlight = null;
    }
  })();
  return maintenanceInFlight;
}

function serviceUnavailable(message: string) {
  return NextResponse.json(
    { error: message, code: "MAINTENANCE" },
    { status: 503 },
  );
}

// ---- RBAC guard: require an active account with minimum role ----
// Automatically enforces:
//   1. Maintenance mode (blocks non-admins)
//   2. Per-account rate limiting (100 req/min — protects all endpoints)
//   3. Role-based access control (minimumRole / exactRole)
// Routes that need stricter limits (scans: 30/min) call checkRateLimitAuthed
// explicitly in addition to this.
export async function requireAuth(
  minimumRole?: Role,
  options?: { exactRole?: boolean },
): Promise<{ account: ApiAccount } | { error: NextResponse }> {
  const account = await getApiAccount();
  if (!account) return { error: unauthorized() };
  if (account.status !== "ACTIVE") {
    return { error: forbidden("Your account is not active") };
  }

  // Maintenance mode: block non-admin users (admins can still access)
  if (account.role !== "ADMIN") {
    const maintenance = await isMaintenanceMode();
    if (maintenance) {
      return {
        error: serviceUnavailable(
          "The system is under maintenance. Please try again later.",
        ),
      };
    }
  }

  // Automatic per-account rate limiting (100 req/min per account).
  // This protects ALL authenticated endpoints without manual calls.
  const rl = await rateLimit(`apiAccount:acct:${account.id}`, "apiAccount");
  if (!rl.allowed) {
    return { error: tooManyRequests(rl.retryAfterMs) };
  }

  if (minimumRole) {
    if (options?.exactRole) {
      if (account.role !== minimumRole) {
        return { error: forbidden() };
      }
    } else if (!hasMinimumRole(account.role, minimumRole)) {
      return { error: forbidden() };
    }
  }
  return { account };
}

// ---- Get the real client IP (anti-spoofing) ----
// In production behind Vercel/Cloudflare, x-forwarded-for is set by the
// proxy and contains: "client-ip, proxy1-ip, proxy2-ip, ..."
// We take the FIRST (leftmost) IP, which is the original client.
// A client CANNOT inject a fake x-forwarded-for because the proxy
// overwrites it. In development (no proxy), we fall back to the
// connection info.
export function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    // Take the first IP in the chain (the original client)
    const firstIp = forwarded.split(",")[0]?.trim();
    if (firstIp) return firstIp;
  }
  // Fall back to x-real-ip (set by some proxies)
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  // Development fallback
  return "unknown";
}

// ---- Rate-limit check for UNAUTHENTICATED endpoints ----
// Uses IP address (parsed safely to prevent spoofing)
export async function checkRateLimit(
  req: NextRequest,
  preset:
    | "login"
    | "register"
    | "otp"
    | "check"
    | "scan"
    | "api"
    | "passkeyOptions"
    | "passkeyVerify",
): Promise<NextResponse | null> {
  const ip = getClientIp(req);
  const result = await rateLimit(`${preset}:ip:${ip}`, preset);
  if (!result.allowed) return tooManyRequests(result.retryAfterMs);
  return null;
}

// ---- Rate-limit check keyed by EMAIL (for login on NAT'd campuses) ----
// On campus WiFi, 200+ students share one public IP. Per-IP limiting would
// block legitimate logins. Per-email limiting allows each student 5 attempts
// while still preventing brute-force on a single account. The per-account
// DB lockout (5 fails → 15-min) remains the primary brute-force defense.
export async function checkRateLimitByEmail(
  email: string,
  preset: "login" | "register" | "otp",
): Promise<NextResponse | null> {
  const normalizedEmail = email.toLowerCase().trim();
  const result = await rateLimit(`${preset}:email:${normalizedEmail}`, preset);
  if (!result.allowed) return tooManyRequests(result.retryAfterMs);
  return null;
}

// ---- Rate-limit check keyed by an arbitrary identifier (user_id checkpoint) ----
// Applied AFTER the request is authenticated or the target account is
// identified. This is the "user_id" checkpoint: even if an attacker rotates
// IPs, the targeted account is throttled. Use with passkeyVerify/loginAccount
// presets after the credential/email lookup resolves the account.
export async function checkRateLimitByKey(
  key: string,
  preset: "passkeyAccount" | "loginAccount" | "scanAccount" | "apiAccount",
): Promise<NextResponse | null> {
  const result = await rateLimit(`${preset}:acct:${key}`, preset);
  if (!result.allowed) return tooManyRequests(result.retryAfterMs);
  return null;
}

// ---- Rate-limit check for AUTHENTICATED endpoints ----
// For scans: per-account ONLY (not per-IP). This is critical for school
//   WiFi where 200+ students share one public IP.
// For other API: per-IP + per-account (standard protection).
export async function checkRateLimitAuthed(
  req: NextRequest,
  accountId: string,
  preset: "scan" | "api",
): Promise<NextResponse | null> {
  // For non-scan endpoints, check the IP-based limit first.
  if (preset !== "scan") {
    const ip = getClientIp(req);
    const ipResult = await rateLimit(`${preset}:ip:${ip}`, preset);
    if (!ipResult.allowed) return tooManyRequests(ipResult.retryAfterMs);
  }

  // Always check the account-based limit (this is the real protection).
  const accountPreset = preset === "scan" ? "scanAccount" : "apiAccount";
  const accountResult = await rateLimit(
    `${accountPreset}:acct:${accountId}`,
    accountPreset,
  );
  if (!accountResult.allowed)
    return tooManyRequests(accountResult.retryAfterMs);

  return null;
}

export async function parseBody<T = unknown>(
  req: NextRequest,
): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
