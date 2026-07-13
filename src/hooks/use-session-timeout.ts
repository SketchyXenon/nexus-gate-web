"use client";

import { useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useLogout } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";

// ====================================================================
// useSessionTimeout — auto-logout after inactivity.
// --------------------------------------------------------------------
// Tracks user activity (mouse, keyboard, touch, scroll). If no activity
// for INACTIVITY_MS (30 min), triggers logout and redirects to the
// login screen with a "session expired" message.
//
// The Supabase access token has its own expiry (set in Supabase
// Dashboard → Auth → JWT expiry), but that only expires the TOKEN —
// the user stays on the page until the next API call returns 401.
// This hook provides a better UX: proactively logs out and shows a
// clear message BEFORE the user encounters a 401 error.
//
// Warning at WARNING_MS (25 min) so the user can stay logged in by
// moving the mouse.
// ====================================================================

const INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes
const WARNING_MS = 25 * 60 * 1000; // 25 minutes
const CHECK_INTERVAL_MS = 30 * 1000; // check every 30s

export function useSessionTimeout(isAuthenticated: boolean) {
  const router = useRouter();
  const logout = useLogout();
  const lastActivityRef = useRef<number>(Date.now());
  const warningShownRef = useRef<boolean>(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const updateActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    if (warningShownRef.current) {
      warningShownRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;

    // Activity listeners.
    const events = ["mousedown", "keydown", "touchstart", "scroll"];
    events.forEach((e) => window.addEventListener(e, updateActivity, { passive: true }));

    // Check inactivity every 30s.
    intervalRef.current = setInterval(() => {
      const inactive = Date.now() - lastActivityRef.current;
      if (inactive >= INACTIVITY_MS) {
        // Session expired — log out.
        if (intervalRef.current) clearInterval(intervalRef.current);
        toast({
          title: "Session expired",
          description: "You've been signed out due to inactivity.",
          variant: "destructive",
        });
        logout.mutate(undefined, {
          onSuccess: () => {
            router.push("/");
            setTimeout(() => window.location.reload(), 500);
          },
          // If the network is down (flaky campus WiFi), the logout request
          // fails. Force-redirect to "/" so the user isn't stuck on the
          // authed page with a stale session toast.
          onError: () => {
            window.location.href = "/";
          },
        });
      } else if (inactive >= WARNING_MS && !warningShownRef.current) {
        // Show warning at 25 min.
        warningShownRef.current = true;
        const remaining = Math.ceil((INACTIVITY_MS - inactive) / 60000);
        toast({
          title: "Session expiring soon",
          description: `You'll be signed out in ${remaining} minute${remaining === 1 ? "" : "s"} due to inactivity. Move your mouse to stay signed in.`,
        });
      }
    }, CHECK_INTERVAL_MS);

    return () => {
      events.forEach((e) => window.removeEventListener(e, updateActivity));
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isAuthenticated, updateActivity, logout, router]);
}
