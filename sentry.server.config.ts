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
});
