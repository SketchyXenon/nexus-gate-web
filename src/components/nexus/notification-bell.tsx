"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useNotifications,
  useMarkNotificationsRead,
  useNotificationStatus,
  useSubscribeNotifications,
  useUnsubscribeNotifications,
} from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data, refetch } = useNotifications();
  const markRead = useMarkNotificationsRead();
  const { data: status } = useNotificationStatus();
  const subscribe = useSubscribeNotifications();
  const unsubscribe = useUnsubscribeNotifications();

  const unreadCount = data?.unreadCount ?? 0;

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  async function handleEnableNotifications() {
    if (!("Notification" in window)) {
      toast({
        title: "Not supported",
        description: "Your browser doesn't support notifications.",
        variant: "destructive",
      });
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toast({
        title: "Permission denied",
        description:
          "You can enable notifications later in your browser settings.",
      });
      return;
    }

    // For now, just mark as enabled in the DB (in-app notifications)
    // In production with VAPID keys, this would register a push subscription
    subscribe.mutate(
      {
        endpoint: "in-app",
        keys: { p256dh: "in-app", auth: "in-app" },
      },
      {
        onSuccess: () =>
          toast({
            title: "Notifications enabled",
            description: "You'll get reminders before your classes start.",
          }),
        onError: () =>
          toast({
            title: "Failed",
            description: "Could not enable notifications.",
            variant: "destructive",
          }),
      },
    );
  }

  function handleDisable() {
    unsubscribe.mutate(undefined, {
      onSuccess: () => toast({ title: "Notifications disabled" }),
    });
  }

  function handleMarkAllRead() {
    markRead.mutate(undefined, {
      onSuccess: () => refetch(),
    });
  }

  function handleClickNotification(id: number) {
    markRead.mutate(id, {
      onSuccess: () => refetch(),
    });
  }

  const notifications = data?.notifications ?? [];
  const isEnabled = status?.enabled ?? false;

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9 relative"
        onClick={() => setOpen(!open)}
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 grid place-items-center rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </Button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-x-2 top-16 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80 sm:max-w-[22rem] z-50"
          >
            <div className="rounded-xl border bg-card shadow-2xl overflow-hidden">
              {/* Header */}
              <div className="p-3 border-b flex items-center justify-between">
                <span className="font-heading font-semibold text-sm">
                  Notifications
                </span>
                {unreadCount > 0 && (
                  <button
                    onClick={handleMarkAllRead}
                    className="text-xs text-primary hover:underline"
                  >
                    Mark all read
                  </button>
                )}
              </div>

              {/* Notifications list */}
              <ScrollArea className="max-h-80">
                {notifications.length === 0 ? (
                  <div className="p-6 text-center">
                    <Bell className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
                    <p className="text-xs text-muted-foreground">
                      No notifications yet.
                    </p>
                  </div>
                ) : (
                  <div className="divide-y">
                    {notifications.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => handleClickNotification(n.id)}
                        className={`w-full text-left p-3 hover:bg-accent/40 transition-colors ${
                          !n.readAt ? "bg-primary/5" : ""
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          {!n.readAt && (
                            <span className="h-2 w-2 rounded-full bg-primary shrink-0 mt-1.5" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">
                              {n.title}
                            </p>
                            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                              {n.body}
                            </p>
                            <p className="text-[10px] text-muted-foreground mt-1">
                              {formatDistanceToNow(new Date(n.createdAt), {
                                addSuffix: true,
                              })}
                            </p>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </ScrollArea>

              {/* Footer: enable/disable */}
              <div className="p-2 border-t">
                {isEnabled ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-muted-foreground"
                    onClick={handleDisable}
                    disabled={unsubscribe.isPending}
                  >
                    {unsubscribe.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <BellOff className="h-3.5 w-3.5" />
                    )}
                    Disable notifications
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-primary"
                    onClick={handleEnableNotifications}
                    disabled={subscribe.isPending}
                  >
                    {subscribe.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Bell className="h-3.5 w-3.5" />
                    )}
                    Enable notifications
                  </Button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
