// ====================================================================
// Nexus Gate — Next.js instrumentation hook
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

  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}
