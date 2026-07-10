"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { useMe } from "@/lib/api-client";
import { LoginScreen } from "@/components/nexus/login-screen";
import { AppShell } from "@/components/nexus/app-shell";
import { ErrorBoundary } from "@/components/nexus/error-boundary";

// PWA shortcut: ?action=scan opens the scanner directly for students.
function getInitialView(): "scanner" | undefined {
  if (typeof window === "undefined") return undefined;
  const params = new URLSearchParams(window.location.search);
  return params.get("action") === "scan" ? "scanner" : undefined;
}

// Check if the URL has a ?code= param (Supabase PKCE email redirect).
// When present, we must render LoginScreen so its useEffect can exchange
// the code — even if useMe() succeeds (the code exchange establishes the
// session, so useMe might return 200 AFTER the exchange).
function hasAuthCode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("code");
}

// Check if a recovery (password reset) flow is pending. This flag is set
// by LoginScreen when finalizeAuth detects a recovery session, and cleared
// when the user completes the password reset. It ensures the reset form
// stays visible even if useMe() succeeds (which would otherwise render
// AppShell and skip the reset form entirely).
function isRecoveryPending(): boolean {
  if (typeof window === "undefined") return false;
  return sessionStorage.getItem("ng_recovery_pending") === "1";
}

export default function Page() {
  const { data: user, isLoading, isError } = useMe();
  const [maintenance, setMaintenance] = useState(false);
  const [maintenanceChecked, setMaintenanceChecked] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setMaintenance(data.maintenanceMode === true);
        setMaintenanceChecked(true);
      })
      .catch(() => setMaintenanceChecked(true));
  }, []);

  if (isLoading || !maintenanceChecked) {
    return (
      <div className="min-h-screen grid place-items-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm">Initializing Nexus Gate…</p>
        </div>
      </div>
    );
  }

  if (maintenance && (!user || user.role !== "ADMIN")) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="mx-auto w-16 h-16 rounded-full bg-amber-500/15 grid place-items-center">
            <span className="text-3xl">!</span>
          </div>
          <div className="space-y-2">
            <h1 className="font-heading text-2xl font-bold">
              Under Maintenance
            </h1>
            <p className="text-sm text-muted-foreground">
              Nexus Gate is currently undergoing maintenance. Please check back
              later.
            </p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="text-sm text-primary hover:underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // If there's a ?code= in the URL (Supabase email redirect), always render
  // LoginScreen so its useEffect can exchange the code. Without this, useMe()
  // might succeed (if the exchange already happened) and render AppShell,
  // skipping the reset form entirely.
  if (hasAuthCode()) {
    return (
      <ErrorBoundary>
        <LoginScreen />
      </ErrorBoundary>
    );
  }

  // If a recovery (password reset) flow is pending, render LoginScreen in
  // reset mode — even if useMe() succeeds. The recovery session is valid
  // but the user hasn't changed their password yet.
  if (isRecoveryPending()) {
    return (
      <ErrorBoundary>
        <LoginScreen />
      </ErrorBoundary>
    );
  }

  // Unauthenticated: show login screen directly (no Turnstile gate).
  // Server-side rate limiting on auth endpoints provides bot protection.
  if (isError || !user) {
    return (
      <ErrorBoundary>
        <LoginScreen />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <AppShell user={user} initialView={getInitialView()} />
    </ErrorBoundary>
  );
}
