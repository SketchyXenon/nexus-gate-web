"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Download, X, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

// ====================================================================
// Service Worker Registration + Install Prompt
//
// 1. Registers /sw.js on mount (production only — skipped in dev)
// 2. Shows "Install app" banner when the browser fires beforeinstallprompt
// 3. Shows "Update available" toast when a new SW takes over
// ====================================================================

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function ServiceWorkerRegister() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    // Only register in production (dev has HMR which conflicts with SW)
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    let updateInterval: ReturnType<typeof setInterval> | undefined;
    let installBannerTimeout: ReturnType<typeof setTimeout> | undefined;

    // Register the service worker
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        // Check for updates every 10 minutes
        updateInterval = setInterval(() => {
          registration.update();
        }, 10 * 60 * 1000);

        // Listen for new service worker taking over
        registration.addEventListener("updatefound", () => {
          const newWorker = registration.installing;
          if (!newWorker) return;
          newWorker.addEventListener("statechange", () => {
            if (
              newWorker.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              // New version installed — show update prompt
              setUpdateAvailable(true);
            }
          });
        });
      })
      .catch(() => {
        // SW registration failed — non-critical, app still works
      });

    // ---- Install prompt ----
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
      // Show the banner after 5 seconds (don't be pushy)
      installBannerTimeout = setTimeout(() => setShowInstallBanner(true), 5000);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      if (updateInterval) clearInterval(updateInterval);
      if (installBannerTimeout) clearTimeout(installBannerTimeout);
    };
  }, []);

  async function handleInstall() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") {
      setShowInstallBanner(false);
    }
    setInstallPrompt(null);
  }

  function handleUpdate() {
    // Tell the waiting SW to skip waiting
    navigator.serviceWorker.controller?.postMessage("SKIP_WAITING");
    setUpdateAvailable(false);
    // Reload to get the new version
    window.location.reload();
  }

  return (
    <>
      {/* Install banner */}
      <AnimatePresence>
        {showInstallBanner && (
          <motion.div
            initial={{ opacity: 0, y: 100 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 100 }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-md"
          >
            <div className="rounded-xl border bg-card p-4 shadow-2xl">
              <div className="flex items-start gap-3">
                <div className="grid place-items-center h-10 w-10 rounded-lg bg-primary/15 text-primary shrink-0">
                  <Download className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">Install Nexus Gate</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Add it to your home screen for faster access — works like an app.
                  </p>
                  <div className="flex gap-2 mt-3">
                    <Button size="sm" onClick={handleInstall}>
                      Install
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setShowInstallBanner(false)}>
                      Not now
                    </Button>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => setShowInstallBanner(false)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Update available toast */}
      <AnimatePresence>
        {updateAvailable && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-4 left-4 right-4 z-50 mx-auto max-w-md"
          >
            <div className="rounded-xl border bg-card p-3 shadow-2xl flex items-center gap-3">
              <RefreshCw className="h-4 w-4 text-primary shrink-0" />
              <p className="text-sm flex-1">A new version is available.</p>
              <Button size="sm" onClick={handleUpdate}>
                Update
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
