// ====================================================================
// Nexus Gate - Dependency Keep-Alive & Auth Pause Protection
// --------------------------------------------------------------------
// WHY THIS EXISTS: Supabase pauses FREE-TIER projects after ~7 days
// without API activity. Nexus Gate keeps AUTH on Supabase (sessions,
// JWT, magic links, password reset - see ARCHITECTURE.md §2
// "split-target"). A paused project means nobody can log in, and
// in-app notifications are useless because the admin cannot log in.
//
// MEASURES (design: docs/supabase-keep-alive.md):
//   M1  Daily server-side ping of {SUPABASE_URL}/auth/v1/health with
//       the anon key - counts as API activity and resets the
//       inactivity clock.
//   M2  Redundant scheduling: embedded in the daily /api/cron/cleanup
//       run (Vercel Hobby caps cron jobs at 2 - both slots are taken)
//       AND exposed at /api/cron/keep-alive for external schedulers
//       (cron-job.org). Either trigger alone keeps the project active.
//   M3  Outage-capable alerting: failures are emailed via SMTP to
//       ADMIN addresses read from the app database (reachable while
//       Supabase is down). Without SMTP: audit log + stderr.
//   M4  Alert state machine: immediate alert on ok->fail, re-alert at
//       most every RE_ALERT_HOURS while failing, recovery notice on
//       fail->ok. State lives in the `settings` table.
//
// TESTABILITY: every effect is injectable via KeepAliveDeps (fetch,
// db, clock, DB ping, alert sender). tests/keep-alive.test.ts drives
// the full state machine with no network and no database. The @/lib/db
// and @/lib/email imports are DYNAMIC on purpose: static imports would
// execute db.ts (throws without DATABASE_URL) at module-load time and
// make the unit tests environment-dependent.
// ====================================================================

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/** Result of a single reachability check. */
export type KeepAliveCheck = "ok" | "degraded" | "down" | "skipped";

/** Overall run result persisted to `keepalive_last_status`. */
export type KeepAliveStatus = "ok" | "fail" | "skipped";

/** Minimal structural view of the Prisma client this module needs. */
export interface KeepAliveDb {
  setting: {
    findUnique(args: {
      where: { key: string };
    }): Promise<{ key: string; value: string } | null>;
    upsert(args: {
      where: { key: string };
      create: { key: string; value: string };
      update: { value: string };
    }): Promise<unknown>;
  };
  account: {
    findMany(args: {
      where: { role: string; isDeactivated: boolean };
      select: { email: boolean; fullName: boolean };
    }): Promise<Array<{ email: string; fullName: string }>>;
  };
}

export interface KeepAliveAlertInput {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export type KeepAliveAlertSender = (input: KeepAliveAlertInput) => Promise<void>;

export interface KeepAliveDeps {
  /** Prisma-like client for settings + admin lookup (default: @/lib/db). */
  db?: KeepAliveDb;
  /** Database reachability probe (default: SELECT 1 on the real client). */
  dbPing?: () => Promise<void>;
  /** HTTP implementation (default: globalThis.fetch). */
  fetchImpl?: typeof fetch;
  /** Clock (default: () => new Date()). */
  now?: () => Date;
  /** Alert delivery (default: SMTP via src/lib/email.ts). */
  sendAlert?: KeepAliveAlertSender;
  /** Supabase auth health ping timeout (default 5000ms). */
  authTimeoutMs?: number;
  /** Database probe timeout (default 3000ms). */
  dbTimeoutMs?: number;
}

export interface KeepAliveSummary {
  ranAt: string;
  supabaseConfigured: boolean;
  status: KeepAliveStatus;
  authCheck: KeepAliveCheck;
  authDetail: string | null;
  dbCheck: KeepAliveCheck;
  dbDetail: string | null;
  /** True when a failure (or recovery) alert was DELIVERED. */
  alerted: boolean;
  alertChannel: "email" | "none" | "skipped";
  /** True when this run observed a fail -> ok transition. */
  recovered: boolean;
}

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** settings-table keys (see docs/supabase-keep-alive.md §4). */
export const KEEPALIVE_KEYS = {
  status: "keepalive_last_status",
  runAt: "keepalive_last_run_at",
  successAt: "keepalive_last_success_at",
  error: "keepalive_last_error",
  alertedAt: "keepalive_last_alerted_at",
} as const;

/** While failing, re-alert at most once per window. */
export const RE_ALERT_HOURS = 24;

const AUTH_TIMEOUT_MS = 5_000;
const DB_TIMEOUT_MS = 3_000;

/** Shown whenever a network-level failure hits a Supabase Cloud URL. */
const PAUSED_HINT =
  "If this project is on the Supabase FREE TIER it may have been PAUSED " +
  "for inactivity (~7 days without API requests). Restore it at " +
  "https://supabase.com/dashboard - see docs/supabase-keep-alive.md §7.";

// ------------------------------------------------------------------
// Pings
// ------------------------------------------------------------------

export interface PingResult {
  check: KeepAliveCheck;
  detail: string | null;
}

/**
 * Pings the Supabase Auth (GoTrue) health endpoint. Any API request
 * through the project counts as activity for Supabase's pause timer -
 * this ping IS the anti-pause measure.
 */
export async function pingSupabaseAuth(
  baseUrl: string,
  anonKey: string | undefined,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<PingResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/auth/v1/health`;
  try {
    const res = await fetchImpl(url, {
      headers: anonKey ? { apikey: anonKey } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { check: "ok", detail: null };
    // The service answered but not healthily: key misconfigured (401/403),
    // or the auth service itself is degraded (5xx). Sign-in would fail.
    return {
      check: "degraded",
      detail: `Supabase Auth health returned HTTP ${res.status} at ${url}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cloudHosted = /supabase\.(co|in|net)/i.test(baseUrl);
    return {
      check: "down",
      detail:
        `Supabase Auth unreachable at ${url}: ${msg}` +
        (cloudHosted ? ` ${PAUSED_HINT}` : ""),
    };
  }
}

/** Wraps the DB probe with a hard timeout so a hung pool can't stall the run. */
async function pingDatabase(
  dbPing: () => Promise<void>,
  timeoutMs: number,
): Promise<PingResult> {
  try {
    await Promise.race([
      dbPing(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`DB probe timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return { check: "ok", detail: null };
  } catch (err) {
    return {
      check: "down",
      detail: `Database probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ------------------------------------------------------------------
// Default (production) dependency implementations
// ------------------------------------------------------------------

/** The real settings/account client. Dynamic import - see header note. */
async function getRealDb(): Promise<KeepAliveDb> {
  const mod = await import("@/lib/db");
  return mod.db as unknown as KeepAliveDb;
}

async function defaultDbPing(): Promise<void> {
  const { db } = await import("@/lib/db");
  await db.$queryRaw`SELECT 1`;
}

async function defaultSendAlert(input: KeepAliveAlertInput): Promise<void> {
  const { sendInfraAlertEmail } = await import("@/lib/email");
  await sendInfraAlertEmail(input);
}

// ------------------------------------------------------------------
// Settings helpers (all best-effort - a watchdog must never throw)
// ------------------------------------------------------------------

async function readSettingSafe(db: KeepAliveDb, key: string): Promise<string | null> {
  try {
    const row = await db.setting.findUnique({ where: { key } });
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function writeSettingSafe(db: KeepAliveDb, key: string, value: string): Promise<boolean> {
  try {
    await db.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    return true;
  } catch (err) {
    console.error(`[keep-alive] failed to persist ${key}:`, err);
    return false;
  }
}

// ------------------------------------------------------------------
// Alerting
// ------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

function buildAlertEmail(ranAt: Date, auth: PingResult, dbRes: PingResult): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `[Nexus Gate] KEEP-ALIVE FAILED - auth/database unreachable (${ranAt.toISOString()})`;
  const lines = [
    "The Nexus Gate dependency keep-alive check FAILED.",
    "",
    `Run at: ${ranAt.toISOString()}`,
    `Supabase Auth (${process.env.NEXT_PUBLIC_SUPABASE_URL ?? "?"}):`,
    `  ${auth.check.toUpperCase()}${auth.detail ? ` - ${auth.detail}` : ""}`,
    `Database:`,
    `  ${dbRes.check.toUpperCase()}${dbRes.detail ? ` - ${dbRes.detail}` : ""}`,
    "",
    "Impact: if Supabase Auth is down/paused, NOBODY CAN LOG IN.",
    "",
    "What to do:",
    "  1. If the detail mentions a PAUSED free-tier project, restore it at",
    "     https://supabase.com/dashboard (see docs/supabase-keep-alive.md §7).",
    "  2. Otherwise check Vercel logs for /api/cron/cleanup and",
    "     /api/cron/keep-alive around this timestamp.",
    "  3. Verify recovery via GET /api/admin/db-health -> keepalive.",
    "",
    "You receive this at most once every 24 hours while the failure",
    "persists, plus one notice when it recovers.",
  ];
  const text = lines.join("\n");
  const html = `<div style="font-family:monospace;font-size:13px;white-space:pre-wrap;background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:16px;">${escapeHtml(text)}</div>`;
  return { subject, text, html };
}

function buildRecoveryEmail(ranAt: Date): { subject: string; text: string; html: string } {
  const subject = `[Nexus Gate] KEEP-ALIVE RECOVERED - auth/database reachable again (${ranAt.toISOString()})`;
  const text = [
    "The Nexus Gate dependency keep-alive check RECOVERED.",
    "",
    `Run at: ${ranAt.toISOString()}`,
    "Supabase Auth and the app database are reachable again.",
    "",
    "If you restored a paused Supabase project, no further action is",
    "needed - the daily ping will keep it active from here on",
    "(docs/supabase-keep-alive.md).",
  ].join("\n");
  const html = `<div style="font-family:monospace;font-size:13px;white-space:pre-wrap;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px;">${escapeHtml(text)}</div>`;
  return { subject, text, html };
}

/**
 * Delivers an alert to all active ADMIN accounts (emails live in the app
 * database, which is reachable even when Supabase is down - that is the
 * whole point of alerting via SMTP rather than in-app notifications).
 * Returns true only when delivery succeeded for at least one recipient
 * AND the alert window was updated (dedupe anchor).
 */
async function deliverAlert(
  deps: KeepAliveDeps,
  db: KeepAliveDb,
  ranAt: Date,
  email: { subject: string; text: string; html: string },
  kind: "failure" | "recovery",
): Promise<boolean> {
  let recipients: string[] = [];
  try {
    const admins = await db.account.findMany({
      where: { role: "ADMIN", isDeactivated: false },
      select: { email: true, fullName: true },
    });
    recipients = admins.map((a) => a.email).filter(Boolean);
  } catch (err) {
    console.error("[keep-alive] admin lookup failed - cannot alert:", err);
  }

  if (recipients.length === 0) {
    // No admins to alert: log loudly (Vercel logs) and do NOT advance the
    // dedupe anchor, so the next run retries delivery.
    console.error(
      `[keep-alive] ${kind.toUpperCase()} detected at ${ranAt.toISOString()} but there is ` +
        "no ADMIN account to notify (and possibly no SMTP). " +
        `Subject: "${email.subject}". Fix the failure and/or add an ADMIN + SMTP config.`,
    );
    return false;
  }

  try {
    const send = deps.sendAlert ?? defaultSendAlert;
    await send({ to: recipients, ...email });
  } catch (err) {
    // SMTP not configured or delivery failed: keep the dedupe anchor
    // untouched so the next run retries. Detection still happened - the
    // failure is persisted in settings + audit log regardless.
    console.error(`[keep-alive] alert delivery failed (${kind}):`, err);
    return false;
  }
  return true;
}

// ------------------------------------------------------------------
// Orchestrator
// ------------------------------------------------------------------

/**
 * Runs one keep-alive cycle: ping Supabase Auth (anti-pause activity) +
 * the app database, persist watchdog state, alert on transitions.
 * NEVER THROWS - a watchdog that crashes would be worse than useless.
 */
export async function runKeepAlive(deps: KeepAliveDeps = {}): Promise<KeepAliveSummary> {
  const now = deps.now ?? (() => new Date());
  try {
    const db = deps.db ?? (await getRealDb());
    const doFetch = deps.fetchImpl ?? globalThis.fetch;
    const baseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
    const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
    const configured = Boolean(baseUrl && anonKey);
    const ranAt = now();

    let auth: PingResult = {
      check: "skipped",
      detail: "Supabase env vars are not set (local/dev) - nothing to ping",
    };
    let dbRes: PingResult = { check: "skipped", detail: "not checked" };

    if (configured) {
      [auth, dbRes] = await Promise.all([
        pingSupabaseAuth(baseUrl, anonKey, deps.authTimeoutMs ?? AUTH_TIMEOUT_MS, doFetch),
        pingDatabase(deps.dbPing ?? defaultDbPing, deps.dbTimeoutMs ?? DB_TIMEOUT_MS),
      ]);
    }

    const status: KeepAliveStatus = !configured
      ? "skipped"
      : auth.check === "ok" && dbRes.check === "ok"
        ? "ok"
        : "fail";

    // Read the PREVIOUS state before overwriting it (transition detection).
    const prevStatusRaw = await readSettingSafe(db, KEEPALIVE_KEYS.status);
    const prevStatus: string | null =
      prevStatusRaw === "ok" || prevStatusRaw === "fail" ? prevStatusRaw : null;

    // Persist state. Skipped runs only touch the run timestamp: a local
    // run without Supabase env must never mask a production failure.
    await writeSettingSafe(db, KEEPALIVE_KEYS.runAt, ranAt.toISOString());
    if (status !== "skipped") {
      await writeSettingSafe(db, KEEPALIVE_KEYS.status, status);
      if (status === "ok") {
        await writeSettingSafe(db, KEEPALIVE_KEYS.successAt, ranAt.toISOString());
        await writeSettingSafe(db, KEEPALIVE_KEYS.error, "");
      } else {
        const errorText = [auth.detail, dbRes.detail].filter(Boolean).join(" | ") || "unknown failure";
        await writeSettingSafe(db, KEEPALIVE_KEYS.error, errorText);
      }
    }

    let alerted = false;
    let alertChannel: KeepAliveSummary["alertChannel"] = "none";
    let recovered = false;

    if (status === "fail") {
      // Alert on the ok/unknown -> fail transition, then at most once per
      // RE_ALERT_HOURS while the failure persists.
      const lastAlertedRaw = await readSettingSafe(db, KEEPALIVE_KEYS.alertedAt);
      const lastAlertedMs = lastAlertedRaw ? Date.parse(lastAlertedRaw) : Number.NaN;
      const windowMs = RE_ALERT_HOURS * 60 * 60 * 1000;
      const dueForAlert =
        Number.isNaN(lastAlertedMs) || ranAt.getTime() - lastAlertedMs >= windowMs;

      if (prevStatus !== "fail" || dueForAlert) {
        const delivered = await deliverAlert(
          deps,
          db,
          ranAt,
          buildAlertEmail(ranAt, auth, dbRes),
          "failure",
        );
        if (delivered) {
          alerted = true;
          alertChannel = "email";
          await writeSettingSafe(db, KEEPALIVE_KEYS.alertedAt, ranAt.toISOString());
        }
      }
    } else if (status === "ok" && prevStatus === "fail") {
      // fail -> ok: send one recovery notice (no dedupe anchor update -
      // recovery notices are single-shot by construction).
      recovered = true;
      const delivered = await deliverAlert(
        deps,
        db,
        ranAt,
        buildRecoveryEmail(ranAt),
        "recovery",
      );
      if (delivered) {
        alerted = true;
        alertChannel = "email";
      }
    }

    // Audit trail (fire-and-forget; audit() never throws). Only for
    // real outcomes - skipped dev runs would just add noise.
    if (status !== "skipped") {
      try {
        const { audit } = await import("@/lib/audit");
        await audit({
          action: `infra.keepalive_${status}`,
          targetType: "Setting",
          targetId: KEEPALIVE_KEYS.status,
          metadata: {
            authCheck: auth.check,
            dbCheck: dbRes.check,
            recovered,
            alerted,
          },
        });
      } catch {
        // audit module unavailable in some test contexts - never fatal.
      }
    }

    return {
      ranAt: ranAt.toISOString(),
      supabaseConfigured: configured,
      status,
      authCheck: auth.check,
      authDetail: auth.detail,
      dbCheck: dbRes.check,
      dbDetail: dbRes.detail,
      alerted,
      alertChannel,
      recovered,
    };
  } catch (err) {
    // Absolute last resort: the watchdog itself must stay observable.
    const ranAt = (deps.now ?? (() => new Date()))();
    console.error("[keep-alive] unexpected internal error:", err);
    return {
      ranAt: ranAt.toISOString(),
      supabaseConfigured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      status: "fail",
      authCheck: "down",
      authDetail: `keep-alive internal error: ${err instanceof Error ? err.message : String(err)}`,
      dbCheck: "skipped",
      dbDetail: null,
      alerted: false,
      alertChannel: "none",
      recovered: false,
    };
  }
}
