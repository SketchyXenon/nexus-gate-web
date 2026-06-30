"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Cookie, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const CONSENT_KEY = "ng_cookie_consent";

export function CookieConsent() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const consent = localStorage.getItem(CONSENT_KEY);
    if (!consent) {
      const timer = setTimeout(() => setShow(true), 1500);
      return () => clearTimeout(timer);
    }
  }, []);

  function accept() {
    localStorage.setItem(CONSENT_KEY, "accepted");
    setShow(false);
  }

  function decline() {
    localStorage.setItem(CONSENT_KEY, "declined");
    setShow(false);
  }

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 100 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 100 }}
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
          className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-2xl"
        >
          <div className="rounded-xl border bg-card p-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="grid place-items-center h-10 w-10 rounded-lg bg-primary/15 text-primary shrink-0">
                <Cookie className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold">Cookie Notice</p>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  We use cookies to keep you signed in and remember your theme
                  preference. We do not sell your data. See our{" "}
                  <button
                    className="text-primary underline hover:no-underline"
                    onClick={() => {
                      const event = new CustomEvent("open-info-modal", { detail: "privacy" });
                      window.dispatchEvent(event);
                    }}
                  >
                    Privacy Policy
                  </button>
                  .
                </p>
                <div className="flex gap-2 mt-3">
                  <Button size="sm" onClick={accept}>
                    Accept
                  </Button>
                  <Button size="sm" variant="outline" onClick={decline}>
                    Decline
                  </Button>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => setShow(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
