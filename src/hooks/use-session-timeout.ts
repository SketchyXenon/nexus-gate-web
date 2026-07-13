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
const SERVER_CHECK_INTERVAL_MS = 5 * 60 * 1000; // verify session every 5 min

export function useSessionTimeout(isAuthenticated: boolean) {
  const router = useRouter();
  const logout = useLogout();
  const lastActivityRef = useRef<number>(Date.now());
  const warningShownRef = useRef<boolean>(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const serverCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const updateActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    if (warningShownRef.current) {
      warningShownRef.current = false;
    }
  }, []);

  // Force logout (shared by inactivity timeout and server-side check).
  const forceLogout = useCallback(
    (reason: string) => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (serverCheckRef.current) clearInterval(serverCheckRef.current);
      toast({
        title: "Session expired",
        description: reason,
        variant: "destructive",
      });
      logout.mutate(undefined, {
        onSuccess: () => {
          router.push("/");
          setTimeout(() => window.location.reload(), 500);
        },
        onError: () => {
          window.location.href = "/";
        },
      });
    },
    [logout, router],
  );

  useEffect(() => {
    if (!isAuthenticated) return;

    // Activity listeners.
    const events = ["mousedown", "keydown", "touchstart", "scroll"];
    events.forEach((e) =>
      window.addEventListener(e, updateActivity, { passive: true }),
    );

    // Check inactivity every 30s (client-side).
    intervalRef.current = setInterval(() => {
      const inactive = Date.now() - lastActivityRef.current;
      if (inactive >= INACTIVITY_MS) {
        forceLogout("You've been signed out due to inactivity.");
      } else if (inactive >= WARNING_MS && !warningShownRef.current) {
        warningShownRef.current = true;
        const remaining = Math.ceil((INACTIVITY_MS - inactive) / 60000);
        toast({
          title: "Session expiring soon",
          description: `You'll be signed out in ${remaining} minute${remaining === 1 ? "" : "s"} due to inactivity. Move your mouse to stay signed in.`,
        });
      }
    }, CHECK_INTERVAL_MS);

    // Server-side session validation every 5 min.
    // Catches the case where the user is active (mouse moves) but the
    // server-side token has expired (Supabase access token TTL, or the
    // account was suspended/demoted server-side).
    serverCheckRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/auth/me", { credentials: "include" });
        if (res.status === 401) {
          forceLogout("Your session is no longer valid. Please sign in again.");
        }
      } catch {
        // Network error — don't log out (flaky WiFi). The next successful
        // API call will trigger the 401 refresh flow if the session expired.
      }
    }, SERVER_CHECK_INTERVAL_MS);

    return () => {
      events.forEach((e) => window.removeEventListener(e, updateActivity));
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (serverCheckRef.current) clearInterval(serverCheckRef.current);
    };
  }, [isAuthenticated, updateActivity, forceLogout]);
}
