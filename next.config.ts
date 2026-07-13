import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  output: "standalone",
  // Strict mode surfaces bugs (double-invoke effects in dev) that hide in
  // production. The codebase has been audited to be strict-mode-safe.
  reactStrictMode: true,
  poweredByHeader: false,
  compiler: {
    removeConsole: process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false,
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "api.dicebear.com" },
    ],
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
