"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// ====================================================================
// TurnstileGate — Cloudflare Turnstile challenge with session persistence
// and graceful degradation.
// ====================================================================
//
// WHY THIS EXISTS:
//   Cloudflare Turnstile protects the login/register forms from bots.
//   It runs a non-interactive check in the background and only shows an
//   interactive challenge if Cloudflare deems the visitor suspicious.
//
// PROBLEMS THIS FIXES (vs. the old version):
//   1. The old version reset `verified` on every mount, so the challenge
//      reappeared on every navigation/refresh. Now we persist verification
//      in sessionStorage with a grace window (4h) — one challenge per
//      browser session.
//   2. The old version had no error handling, so Turnstile config errors
//      (e.g. 600010, cdn-cgi 404 on Vercel) permanently trapped users.
//      Now we show a "Continue" fallback after 8s or on error.
//   3. The old version used size:"normal" (always-visible widget). Now we
//      use appearance:"execute" — Turnstile runs invisibly and only shows
//      the interactive widget if Cloudflare flags the visitor.
//
// SECURITY NOTE:
//   This page-level gate is the SOLE bot-protection boundary. It runs
//   before the landing/login page. Server-side rate limiting on login/
//   register endpoints provides the brute-force defense. The gate
//   persists verification in sessionStorage (4h grace) so users only
//   see the challenge once per session.

const STORAGE_KEY = "ng_turnstile_verified";
// How long a verification is trusted (ms). 4 hours = a typical study
// session. After this, the user is re-challenged on the next visit.
const GRACE_MS = 4 * 60 * 60 * 1000;
// If Turnstile doesn't resolve within this time, show a fallback "Continue"
// button so users are never permanently trapped by a misconfigured widget.
const FALLBACK_TIMEOUT_MS = 8_000;

interface TurnstileGateProps {
  children: React.ReactNode;
}

type TurnstileComponent = typeof import("@marsidev/react-turnstile").Turnstile;

// Check sessionStorage for a valid recent verification.
function isRecentlyVerified(): boolean {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { at?: number };
    if (typeof parsed.at !== "number") return false;
    return Date.now() - parsed.at < GRACE_MS;
  } catch {
    return false;
  }
}

function rememberVerification() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ at: Date.now() }));
  } catch {
    // sessionStorage might be unavailable (private mode) — non-critical.
  }
}

export function TurnstileGate({ children }: TurnstileGateProps) {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || null;

  // If no site key is configured (e.g. local dev), render children directly.
  // If there's a valid recent verification in sessionStorage, skip the gate.
  const [verified, setVerified] = useState<boolean>(
    !siteKey || isRecentlyVerified(),
  );
  const [TurnstileComp, setTurnstileComp] = useState<TurnstileComponent | null>(
    null,
  );
  const [showFallback, setShowFallback] = useState(false);
  const [errored, setErrored] = useState(false);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mark as verified + persist to sessionStorage.
  const handleVerified = useCallback(() => {
    rememberVerification();
    setVerified(true);
  }, []);

  // Lazily load the Turnstile widget only when we actually need it.
  useEffect(() => {
    if (!siteKey || verified) return;
    let cancelled = false;
    import("@marsidev/react-turnstile").then((mod) => {
      if (!cancelled) setTurnstileComp(() => mod.Turnstile);
    });
    return () => {
      cancelled = true;
    };
  }, [siteKey, verified]);

  // Fallback timer — if Turnstile doesn't resolve within the timeout, show
  // a "Continue" button so a misconfigured widget can't trap the user.
  useEffect(() => {
    if (!siteKey || verified) return;
    fallbackTimer.current = setTimeout(() => {
      setShowFallback(true);
    }, FALLBACK_TIMEOUT_MS);
    return () => {
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    };
  }, [siteKey, verified]);

  // No site key OR already verified this session → render children.
  if (!siteKey || verified) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-sm w-full space-y-6 text-center"
      >
        <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 grid place-items-center">
          <ShieldCheck className="h-8 w-8 text-primary" />
        </div>
        <div className="space-y-2">
          <h1 className="font-heading text-xl font-semibold">
            Verifying your connection
          </h1>
          <p className="text-sm text-muted-foreground">
            Running a quick security check. This usually finishes in a moment.
          </p>
        </div>

        {/* Turnstile widget — invisible by default (appearance:"execute"),
            only shows the interactive challenge if Cloudflare flags the
            visitor as suspicious. */}
        <div className="flex justify-center min-h-[65px] items-center">
          {TurnstileComp ? (
            <TurnstileComp
              siteKey={siteKey}
              onSuccess={handleVerified}
              onError={() => {
                console.warn("[turnstile] widget error — enabling fallback");
                setErrored(true);
                setShowFallback(true);
              }}
              onExpire={() => {
                // Token expired — widget will auto-refresh; no action needed.
              }}
              options={{
                theme: "auto",
                // "execute" = run invisibly, only show challenge if needed.
                appearance: "execute",
                size: "normal",
                retry: "auto",
                refreshExpired: "auto",
              }}
            />
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading verification…</span>
            </div>
          )}
        </div>

        {/* Fallback button — appears after timeout or on error.
            This ensures a misconfigured Turnstile (e.g. the 600010 /
            cdn-cgi 404 errors seen on Vercel) can never permanently
            lock users out of the app. The server-side rate limiter
            still provides the real bot protection. */}
        <AnimatePresence>
          {showFallback && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="space-y-2"
            >
              {errored ? (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  Verification service is temporarily unavailable. You can
                  continue — rate limiting still protects the login.
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Taking longer than usual? You can continue and try again.
                </p>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleVerified}
                className="w-full"
              >
                Continue to Nexus Gate
              </Button>
            </motion.div>
          )}
        </AnimatePresence>

        <p className="text-[11px] text-muted-foreground">
          Protected by Cloudflare Turnstile. Your data is never shared.
        </p>
      </motion.div>
    </div>
  );
}
