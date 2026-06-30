"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Wrench, ShieldCheck, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/nexus/confirm-dialog";
import { toast } from "@/hooks/use-toast";

// ====================================================================
// Nexus Gate — Maintenance Mode UI
//
// Two exports:
//   1. MaintenancePanel — admin dashboard card. Lets an admin flip the
//      maintenance_mode setting on/off and edit the notice message.
//   2. MaintenanceScreen — full-screen page shown to non-admin users
//      when maintenance mode is ON (the API blocks them at requireAuth).
// ====================================================================

interface MaintenanceSettings {
  maintenanceMode: boolean;
  maintenanceMessage: string;
}

async function fetchSettings(): Promise<MaintenanceSettings> {
  const res = await fetch("/api/settings", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load maintenance settings");
  return res.json();
}

async function toggleMaintenance(
  enabled: boolean,
  message?: string
): Promise<{ ok: boolean; maintenanceMode: boolean; message: string | null }> {
  const res = await fetch("/api/admin/maintenance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ enabled, message }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || "Failed to update maintenance mode");
  }
  return res.json();
}

// ====================================================================
// MaintenancePanel — admin card
// ====================================================================
export function MaintenancePanel() {
  const [settings, setSettings] = useState<MaintenanceSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingEnable, setPendingEnable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSettings()
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        setMessage(s.maintenanceMessage ?? "");
      })
      .catch(() => {
        if (cancelled) return;
        toast({
          title: "Couldn't load settings",
          description: "Please refresh the page.",
          variant: "destructive",
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function openConfirm(enable: boolean) {
    setPendingEnable(enable);
    setConfirmOpen(true);
  }

  async function handleConfirm() {
    setSaving(true);
    try {
      const result = await toggleMaintenance(pendingEnable, message.trim() || undefined);
      setSettings({
        maintenanceMode: result.maintenanceMode,
        maintenanceMessage: result.message ?? "",
      });
      toast({
        title: result.maintenanceMode
          ? "Maintenance mode is on"
          : "Maintenance mode is off",
        description: result.maintenanceMode
          ? "Students and organizers are now blocked. You can still sign in as an admin."
          : "Everyone can sign in normally again.",
      });
    } catch (e) {
      toast({
        title: "Couldn't change maintenance mode",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
      throw e;
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wrench className="h-4 w-4" />
            Maintenance mode
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading current status…
        </CardContent>
      </Card>
    );
  }

  const isOn = settings?.maintenanceMode ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wrench className="h-4 w-4" />
          Maintenance mode
        </CardTitle>
        <CardDescription>
          Turn this on to temporarily block students and organizers from
          signing in. Useful during upgrades or end-of-term resets.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status row */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-muted-foreground">Current status:</span>
          {isOn ? (
            <Badge className="bg-amber-600 text-white hover:bg-amber-600/90">
              <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
              Active
            </Badge>
          ) : (
            <Badge variant="outline">Off</Badge>
          )}
        </div>

        {/* Message editor */}
        <div className="space-y-2">
          <label htmlFor="maintenance-message" className="text-sm font-medium">
            Message shown to users
          </label>
          <Textarea
            id="maintenance-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="The system is under maintenance. Please check back later."
            rows={3}
            maxLength={500}
            disabled={saving}
          />
          <p className="text-xs text-muted-foreground">
            This message appears on the sign-in screen and any blocked page.
          </p>
        </div>

        {/* Action button */}
        <div className="flex flex-wrap items-center gap-2">
          {isOn ? (
            <Button
              variant="outline"
              onClick={() => openConfirm(false)}
              disabled={saving}
            >
              <Wrench className="h-4 w-4" />
              Turn off maintenance
            </Button>
          ) : (
            <Button
              className="bg-amber-600 text-white hover:bg-amber-600/90"
              onClick={() => openConfirm(true)}
              disabled={saving}
            >
              <Wrench className="h-4 w-4" />
              Turn on maintenance
            </Button>
          )}
        </div>

        {/* Security note */}
        <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-xs text-muted-foreground">
          <ShieldCheck className="h-4 w-4 mt-0.5 text-primary shrink-0" />
          <span>
            Admins always bypass the maintenance block. You can sign out and
            back in to confirm the user-facing experience, but your own admin
            access will keep working.
          </span>
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(o) => {
          setConfirmOpen(o);
          if (!o) setSaving(false);
        }}
        title={pendingEnable ? "Turn on maintenance mode?" : "Turn off maintenance mode?"}
        description={
          pendingEnable
            ? "Students and organizers will be signed out and won't be able to sign back in until you turn this off. Admins keep access."
            : "Everyone will be able to sign in and use the system normally again."
        }
        confirmLabel={pendingEnable ? "Turn on" : "Turn off"}
        cancelLabel="Cancel"
        destructive={pendingEnable}
        confirmText={pendingEnable ? "ENABLE" : "DISABLE"}
        step2Warning={
          pendingEnable
            ? "Users will be blocked immediately."
            : "Please confirm you want to re-open the system."
        }
        onConfirm={handleConfirm}
      />
    </Card>
  );
}

// ====================================================================
// MaintenanceScreen — full-screen for non-admins
// ====================================================================
export function MaintenanceScreen({
  message,
  onRetry,
}: {
  message?: string | null;
  onRetry?: () => void;
}) {
  const notice =
    message ||
    "The system is under maintenance. Please check back later.";

  return (
    <div
      role="alert"
      aria-live="polite"
      className="min-h-screen flex items-center justify-center p-6 bg-background"
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="max-w-md w-full text-center space-y-6"
      >
        <motion.div
          animate={{ scale: [1, 1.08, 1] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          className="mx-auto w-20 h-20 rounded-full bg-primary/10 grid place-items-center"
        >
          <Wrench className="h-10 w-10 text-primary" aria-hidden />
        </motion.div>

        <div className="space-y-2">
          <h1 className="font-heading text-2xl font-semibold">
            Under Maintenance
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {notice}
          </p>
        </div>

        <p className="text-xs text-muted-foreground">
          Please check back later.
        </p>

        {onRetry && (
          <Button variant="outline" onClick={onRetry}>
            <RefreshCw className="h-4 w-4" />
            Try again
          </Button>
        )}
      </motion.div>
    </div>
  );
}
