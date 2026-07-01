"use client";

import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import { Loader2 } from "lucide-react";

// ====================================================================
// TurnstileField — invisible Cloudflare Turnstile widget for forms.
// ====================================================================
//
// Unlike TurnstileGate (a page-level cosmetic gate), TurnstileField
// produces a REAL token that the server verifies via siteverify. It's
// the actual anti-bot boundary.
//
// USAGE (inside a form):
//   const [cfToken, setCfToken] = useState<string>("");
//   const turnstileRef = useRef<TurnstileFieldRef>(null);
//   ...
//   <TurnstileField ref={turnstileRef} onToken={setCfToken} />
//   ...
//   // On submit:
//   login.mutate({ email, password, cfToken });
//   // After error (so the widget can get a fresh token):
//   turnstileRef.current?.reset();
//
// The widget is invisible (appearance:"execute") — it runs a background
// check and only shows an interactive challenge if Cloudflare flags the
// visitor. Most users never see it.
//
// If no site key is configured (dev), the field renders nothing and
// calls onToken with an empty string — the server's requireTurnstile()
// also skips verification when the secret isn't set, so dev works.

export interface TurnstileFieldRef {
  reset: () => void;
}

interface TurnstileFieldProps {
  onToken: (token: string) => void;
  onError?: () => void;
}

export const TurnstileField = forwardRef<TurnstileFieldRef, TurnstileFieldProps>(
  function TurnstileField({ onToken, onError }, ref) {
    const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || null;
    const [TurnstileComp, setTurnstileComp] = useState<typeof import("@marsidev/react-turnstile").Turnstile | null>(null);
    const widgetRef = useRef<{ reset: () => void } | null>(null);

    // Expose reset() to the parent via the forwarded ref so it can
    // refresh the token after a failed submission (tokens are single-use).
    useImperativeHandle(ref, () => ({
      reset: () => {
        try {
          widgetRef.current?.reset();
        } catch {
          // reset can throw if the widget isn't mounted yet — ignore.
        }
      },
    }));

    // Lazily load the Turnstile widget.
    useEffect(() => {
      if (!siteKey) {
        // No site key — signal an empty token so the form can still submit.
        // The server skips verification when TURNSTILE_SECRET_KEY is unset.
        onToken("");
        return;
      }
      let cancelled = false;
      import("@marsidev/react-turnstile").then((mod) => {
        if (!cancelled) setTurnstileComp(() => mod.Turnstile);
      });
      return () => {
        cancelled = true;
      };
    }, [siteKey, onToken]);

    // No site key configured → render nothing (dev mode).
    if (!siteKey) return null;

    return (
      <div className="min-h-[20px]">
        {TurnstileComp ? (
          <TurnstileComp
            ref={(el: { reset: () => void } | null) => {
              widgetRef.current = el;
            }}
            siteKey={siteKey}
            onSuccess={onToken}
            onError={() => {
              console.warn("[turnstile-field] widget error");
              onToken("");
              onError?.();
            }}
            onExpire={() => {
              // Token expired — clear it so the form can't submit a stale one.
              onToken("");
            }}
            options={{
              theme: "auto",
              appearance: "execute", // invisible — only shows challenge if needed
              size: "normal",
              retry: "auto",
              refreshExpired: "auto",
            }}
          />
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Loading security check…</span>
          </div>
        )}
      </div>
    );
  }
);
