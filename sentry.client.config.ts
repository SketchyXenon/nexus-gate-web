// ====================================================================
// Nexus Gate — Sentry client config
//
// Initializes Sentry on the browser. The DSN comes from
// NEXT_PUBLIC_SENTRY_DSN — if it's missing, Sentry is a no-op.
//
// Traces sample rate is intentionally low (10%) to stay within the free
// Sentry tier while still capturing representative performance data.
// Errors are always captured at 100%.
//
// Disabled in development so local console output stays clean.
// ====================================================================

import * as Sentry from "@sentry/nextjs";

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;
const isProduction = process.env.NODE_ENV === "production";

Sentry.init({
  dsn: SENTRY_DSN,
  // Only enable in production AND when a DSN is configured.
  enabled: isProduction && Boolean(SENTRY_DSN),
  environment: process.env.NODE_ENV,
  // 10% of transactions are traced for performance monitoring.
  tracesSampleRate: 0.1,
  // Errors are always sent.
  sampleRate: 1.0,
  // Don't replay sessions in dev to keep the bundle small.
  replaysSessionSampleRate: 0,
  // Sample 1% of error sessions for replays (Sentry free = 100/mo cap).
  replaysOnErrorSampleRate: isProduction ? 0.01 : 0,
  // Ignore common browser-extension noise.
  ignoreErrors: [
    "top.GLOBALS",
    "ResizeObserver loop limit exceeded",
    "ResizeObserver loop completed with undelivered notifications",
    "Network request failed",
  ],
  integrations: [],
});
