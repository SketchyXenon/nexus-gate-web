// ====================================================================
// Nexus Gate - Next.js instrumentation hook
//
// Next.js automatically calls register() once when the server boots
// (Node runtime) and once when the Edge runtime initializes. We use
// this to import the matching Sentry config file for each runtime.
//
// Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
// ====================================================================

export async function register() {
  // Next.js sets NEXT_RUNTIME to either "nodejs" or "edge" before
  // importing instrumentation. We branch on it so each runtime only
  // loads its own Sentry config (avoiding Node-only APIs in edge).

  // Sentry is optional observability. Skip entirely when no DSN is
  // configured (the sentry.*.config files no-op anyway) and degrade
  // gracefully when the package is missing instead of letting the
  // instrumentation hook fail and pollute the boot log - mirroring
  // the fail-soft guard already used in next.config.ts.
  const hasDsn = process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN;
  if (!hasDsn) return;

  try {
    if (process.env.NEXT_RUNTIME === "nodejs") {
      await import("./sentry.server.config");
    }
    if (process.env.NEXT_RUNTIME === "edge") {
      await import("./sentry.edge.config");
    }
  } catch (err) {
    console.warn(
      "[instrumentation] SENTRY_DSN set but Sentry failed to load - continuing without Sentry.",
      err instanceof Error ? err.message : err,
    );
  }
}
