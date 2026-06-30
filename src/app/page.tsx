"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { useMe } from "@/lib/api-client";
import { LoginScreen } from "@/components/nexus/login-screen";
import { AppShell } from "@/components/nexus/app-shell";
import { ErrorBoundary } from "@/components/nexus/error-boundary";
import { TurnstileGate } from "@/components/nexus/turnstile-gate";

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

  // Maintenance mode: non-admins see the maintenance screen
  if (maintenance && (!user || user.role !== "ADMIN")) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="mx-auto w-16 h-16 rounded-full bg-amber-500/15 grid place-items-center">
            <span className="text-3xl">🔧</span>
          </div>
          <div className="space-y-2">
            <h1 className="font-heading text-2xl font-bold">Under Maintenance</h1>
            <p className="text-sm text-muted-foreground">
              Nexus Gate is currently undergoing maintenance. Please check back later.
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

  // Turnstile gate wraps everything — shows challenge for suspicious connections
  return (
    <TurnstileGate>
      {isError || !user ? (
        <ErrorBoundary>
          <LoginScreen />
        </ErrorBoundary>
      ) : (
        <ErrorBoundary>
          <AppShell user={user} />
        </ErrorBoundary>
      )}
    </TurnstileGate>
  );
}
