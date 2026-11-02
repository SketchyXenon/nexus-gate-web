import type { NextConfig } from "next";

// Vercel sets this at build time. When on Vercel, we use the default build
// output (Vercel optimizes it automatically). When self-hosting (Docker/VPS),
// output: "standalone" produces a self-contained server bundle at
// .next/standalone/server.js that can be run with `node .next/standalone/server.js`.
// Enabling standalone on Vercel causes ENOENT errors on .next/next-server.js.nft.json
// because Vercel's build pipeline relocates tracing artifacts.
const isVercel = !!process.env.VERCEL;

const nextConfig: NextConfig = {
  // Only enable standalone output for self-hosted deployments (not Vercel).
  ...(!isVercel && { output: "standalone" as const }),
  reactStrictMode: true,
  poweredByHeader: false,
  // Allow the sandbox preview host to access Next.js dev-only resources
  // (HMR, stack frames) so the preview panel works in development.
  allowedDevOrigins: ["*.space-z.ai"],
  // Prisma 7 driver adapters must stay OUTSIDE the server bundle:
  //  - better-sqlite3 is a NAPI native module (cannot be bundled).
  //  - prisma-adapter-bun-sqlite imports "bun:sqlite", which only exists
  //    in the Bun runtime - bundling it would fail the Node build. It is
  //    loaded at runtime only when the code executes under Bun (see
  //    src/lib/db-adapter.ts; the app itself always runs under Node).
  serverExternalPackages: [
    "prisma-adapter-bun-sqlite",
    "@prisma/adapter-better-sqlite3",
    "@prisma/adapter-mariadb",
    "@prisma/adapter-pg",
    "better-sqlite3",
    "mariadb",
  ],
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
// @sentry/nextjs package degrades gracefully - the app runs without Sentry
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
    // Package not installed - fall back to plain config. Sentry is optional.
    console.warn(
      "[next.config] SENTRY_DSN set but @sentry/nextjs not installed - running without Sentry.",
    );
  }
}

export default config;
