import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

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

// Only wrap with Sentry config if Sentry is configured.
// When SENTRY_DSN is not set, Sentry's wrapper can cause runtime errors
// on Vercel (the "Something went wrong" error page).
const hasSentry = process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN;

export default hasSentry
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      silent: true,
      sourcemaps: { deleteSourcemapsAfterUpload: true },
    })
  : nextConfig;
