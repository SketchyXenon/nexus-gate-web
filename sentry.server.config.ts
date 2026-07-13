// ====================================================================
// Nexus Gate — Sentry server config (Node.js runtime)
//
// Loaded by instrumentation.ts on every server-side boot. Captures
// errors thrown in API routes, server components, and server actions.
//
// 5% trace sample rate keeps the free Sentry tier sustainable while
// still giving us long-tail latency data. Disabled entirely in dev so
// local logs aren't polluted.
// ====================================================================

import * as Sentry from "@sentry/nextjs";

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN ?? process.env.SENTRY_DSN;
const isProduction = process.env.NODE_ENV === "production";

Sentry.init({
  dsn: SENTRY_DSN,
  enabled: isProduction && Boolean(SENTRY_DSN),
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.05,
  sampleRate: 1.0,
  // Server-side: surface the request URL (no PII) for context.
  initialScope: {
    tags: { runtime: "node" },
  },
  // PII scrubbing: strip student emails, IDs, and secret-bearing query
  // params before any event leaves the server. Sentry's default scrubbing
  // covers cookies and some headers, but request bodies and URL query
  // params (e.g. cron secrets) can leak without an explicit beforeSend.
  beforeSend(event) {
    if (event.request) {
      // Scrub secret-bearing query params from the request URL.
      if (event.request.url) {
        try {
          const url = new URL(event.request.url);
          ["secret", "token", "key", "cron_secret", "password"].forEach((p) => {
            if (url.searchParams.has(p)) url.searchParams.set(p, "[Redacted]");
          });
          event.request.url = url.toString();
        } catch {
          // URL parsing failed — leave as-is (Sentry will truncate).
        }
      }
      // Drop request bodies entirely (may contain passwords / student data).
      delete event.request.data;
    }
    // Scrub user email (keep the id for correlation).
    if (event.user) {
      delete event.user.email;
      delete event.user.ip_address;
    }
    return event;
  },
});
