"use client";

import { Component, type ReactNode, type ErrorInfo } from "react";
import { AlertTriangle, RotateCcw, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import * as Sentry from "@sentry/nextjs";

// ====================================================================
// Nexus Gate — Error Boundary
//
// Catches render-time errors anywhere in the subtree and shows a
// friendly fallback instead of a blank white screen. Every error is
// reported to Sentry via Sentry.captureException() so we can see what
// broke in production.
//
// Three fallback modes:
//   1. full-page (default) — for top-level routes / app shell
//   2. compact             — for cards, sidebars, small widgets
//   3. custom              — caller passes its own fallback render
//
// In development the fallback also shows the raw error message and
// stack trace so you can debug without opening the console.
// ====================================================================

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Render a smaller, inline fallback (for cards / sidebars). */
  compact?: boolean;
  /** Provide your own fallback node. Overrides compact. */
  fallback?: (error: Error, retry: () => void) => ReactNode;
  /** Called for every error in addition to Sentry reporting. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Report to Sentry — the React component stack is included so the
    // Sentry breadcrumb shows which component tree threw.
    Sentry.captureException(error, { contexts: { react: { componentStack: info.componentStack } } });
    // Surface to console in dev for quick debugging.
    if (process.env.NODE_ENV !== "production") {
      console.error("[ErrorBoundary]", error, info.componentStack);
    }
    this.props.onError?.(error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    // Caller-provided custom fallback wins.
    if (this.props.fallback) {
      return <>{this.props.fallback(error, this.reset)}</>;
    }

    if (this.props.compact) {
      return <CompactFallback error={error} retry={this.reset} />;
    }

    return <FullPageFallback error={error} retry={this.reset} />;
  }
}

// ---- Full-page fallback (default) ----
function FullPageFallback({ error, retry }: { error: Error; retry: () => void }) {
  const isDev = process.env.NODE_ENV !== "production";
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="min-h-screen flex items-center justify-center p-6 bg-background"
    >
      <div className="max-w-md w-full text-center space-y-4">
        <div className="mx-auto w-14 h-14 rounded-full bg-destructive/15 grid place-items-center">
          <AlertTriangle className="h-8 w-8 text-destructive" aria-hidden />
        </div>
        <div className="space-y-1">
          <h1 className="font-heading text-xl font-semibold">
            Something went wrong
          </h1>
          <p className="text-sm text-muted-foreground">
            An unexpected error occurred while loading this page. Try
            refreshing, or use the button below to try again.
          </p>
        </div>

        {isDev && (
          <pre
            className="text-left text-xs bg-muted p-3 rounded-md overflow-auto max-h-40 whitespace-pre-wrap break-words"
            aria-label="Error details"
          >
            {error.message}
            {error.stack ? `\n\n${error.stack}` : ""}
          </pre>
        )}

        <div className="flex gap-2 justify-center pt-2">
          <Button onClick={() => window.location.reload()}>
            <RefreshCw className="h-4 w-4" />
            Refresh page
          </Button>
          <Button variant="outline" onClick={retry}>
            <RotateCcw className="h-4 w-4" />
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- Compact fallback (for cards / sidebars) ----
function CompactFallback({ error, retry }: { error: Error; retry: () => void }) {
  const isDev = process.env.NODE_ENV !== "production";
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-center space-y-2"
    >
      <div className="flex items-center justify-center gap-2 text-destructive">
        <AlertTriangle className="h-4 w-4" aria-hidden />
        <span className="text-sm font-medium">This section failed to load</span>
      </div>

      {isDev && (
        <p className="text-xs text-muted-foreground line-clamp-3 break-words">
          {error.message}
        </p>
      )}

      <Button size="sm" variant="outline" onClick={retry}>
        <RotateCcw className="h-3.5 w-3.5" />
        Try again
      </Button>
    </div>
  );
}

// ---- Convenience wrappers ----
/** Drop-in full-page error boundary. */
export function PageErrorBoundary({ children }: { children: ReactNode }) {
  return <ErrorBoundary>{children}</ErrorBoundary>;
}

/** Compact error boundary for cards / sidebars. */
export function CardErrorBoundary({ children }: { children: ReactNode }) {
  return <ErrorBoundary compact>{children}</ErrorBoundary>;
}
