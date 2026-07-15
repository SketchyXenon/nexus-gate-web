import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  compiler: {
    removeConsole:
      process.env.NODE_ENV === "production"
        ? { exclude: ["error", "warn"] }
        : false,
  },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "api.dicebear.com" }],
  },
  // Override Vercel's default Access-Control-Allow-Origin: * on API routes.
  // Credentialed requests (cookies) require a specific origin, not a wildcard.
  // Setting it to the configured app URL ensures only same-origin requests
  // can access the API. Falls back to "*" in dev (no app URL configured).
  async headers() {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    const origin = appUrl ? new URL(appUrl).origin : "*";
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: origin },
          {
            key: "Access-Control-Allow-Methods",
            value: "GET, POST, PATCH, PUT, DELETE, OPTIONS",
          },
          {
            key: "Access-Control-Allow-Headers",
            value: "Content-Type, Authorization",
          },
          { key: "Access-Control-Allow-Credentials", value: "true" },
          { key: "Vary", value: "Origin" },
        ],
      },
    ];
  },
};

// Only wrap with Sentry config if Sentry is configured AND the package is
// importable. The import is deferred (dynamic require) so a missing
// @sentry/nextjs package degrades gracefully — the app runs without Sentry
// instead of failing to load next.config.ts (which caused the 404-on-every-
// route cascade in a previous incident).
const hasSentry = process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN;

let config = nextConfig;
if (hasSentry) {
  try {
    // Dynamic require so a missing package doesn't crash config loading.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { withSentryConfig } = require("@sentry/nextjs");
    config = withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      silent: true,
      sourcemaps: { deleteSourcemapsAfterUpload: true },
    });
  } catch {
    // Package not installed — fall back to plain config. Sentry is optional.
    console.warn(
      "[next.config] SENTRY_DSN set but @sentry/nextjs not installed — running without Sentry.",
    );
  }
}

export default config;
