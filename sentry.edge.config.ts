// ====================================================================
// Nexus Gate — Sentry edge config (Edge Runtime)
//
// Edge runtime is used by Next.js middleware/proxy and edge API routes.
// Edge has different constraints than the Node runtime (no `os` module,
// limited AsyncLocalStorage), so we keep this config minimal.
//
// 5% trace sample rate matches the server config for consistency.
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
  initialScope: {
    tags: { runtime: "edge" },
  },
});
