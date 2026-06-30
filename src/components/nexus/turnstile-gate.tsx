"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { ShieldCheck } from "lucide-react";

// TurnstileGate - Cloudflare Turnstile challenge.
// Shows a challenge only when a site key is configured.
// If no key is set, children render directly (dev bypass).

interface TurnstileGateProps {
  children: React.ReactNode;
  force?: boolean;
}

export function TurnstileGate({ children }: TurnstileGateProps) {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || null;
  const [verified, setVerified] = useState(!siteKey);
  const [TurnstileComp, setTurnstileComp] = useState<typeof import("@marsidev/react-turnstile").Turnstile | null>(null);

  useEffect(() => {
    if (!siteKey || verified) return;
    import("@marsidev/react-turnstile").then((mod) => {
      setTurnstileComp(() => mod.Turnstile);
    });
  }, [siteKey, verified]);

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
          <h1 className="font-heading text-xl font-semibold">Verifying your connection</h1>
          <p className="text-sm text-muted-foreground">
            We detected unusual activity from your network. Please complete the verification to continue.
          </p>
        </div>
        <div className="flex justify-center">
          {TurnstileComp ? (
            <TurnstileComp
              siteKey={siteKey}
              onSuccess={() => setVerified(true)}
              options={{ theme: "auto", size: "normal" }}
            />
          ) : (
            <div className="h-16 w-64 animate-pulse bg-muted rounded-md" />
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Protected by Cloudflare Turnstile. Your data is never shared.
        </p>
      </motion.div>
    </div>
  );
}
