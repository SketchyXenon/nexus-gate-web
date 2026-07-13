"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, BellOff, Loader2, CalendarClock, AlarmClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useNotifications,
  useMarkNotificationsRead,
  useNotificationStatus,
  useSubscribeNotifications,
  useUnsubscribeNotifications,
  useEvents,
} from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { formatDistanceToNow, format, isAfter, parseISO } from "date-fns";

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

  // Upcoming events for the reminder section (students + organizers).
  const { data: eventsData } = useEvents();
  const upcomingEvents = (eventsData?.events ?? [])
    .filter((e) => {
      try {
        return isAfter(parseISO(e.scheduledAt), new Date());
      } catch {
        return false;
      }
    })
    .sort((a, b) => {
      try {
        return parseISO(a.scheduledAt).getTime() - parseISO(b.scheduledAt).getTime();
      } catch {
        return 0;
      }
    })
    .slice(0, 3);

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

              {/* Upcoming events reminder section */}
              {upcomingEvents.length > 0 && (
                <div className="border-b">
                  <div className="px-3 py-2 bg-primary/5 flex items-center gap-1.5">
                    <AlarmClock className="h-3.5 w-3.5 text-primary" />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-primary">
                      Coming up
                    </span>
                  </div>
                  <div className="divide-y">
                    {upcomingEvents.map((e) => {
                      const eventDate = parseISO(e.scheduledAt);
                      const isSoon =
                        eventDate.getTime() - Date.now() < 30 * 60 * 1000; // < 30 min
                      return (
                        <div
                          key={e.id}
                          className="px-3 py-2.5 flex items-start gap-2 hover:bg-accent/30 transition-colors"
                        >
                          <CalendarClock
                            className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${
                              isSoon ? "text-amber-500" : "text-muted-foreground"
                            }`}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium truncate">
                              {e.title}
                            </p>
                            <p
                              className={`text-[10px] mt-0.5 ${
                                isSoon
                                  ? "text-amber-600 font-medium"
                                  : "text-muted-foreground"
                              }`}
                            >
                              {format(eventDate, "EEE, MMM d 'at' h:mm a")}
                              {" · "}
                              {formatDistanceToNow(eventDate, { addSuffix: true })}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Notifications list */}
              <ScrollArea className="max-h-80">
                {notifications.length === 0 ? (
                  <div className="p-6 text-center">
                    <div className="grid place-items-center h-10 w-10 rounded-full bg-muted/50 mx-auto mb-2">
                      <Bell className="h-4 w-4 text-muted-foreground/60" />
                    </div>
                    <p className="text-xs font-medium text-muted-foreground">
                      All caught up
                    </p>
                    <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                      New notifications will appear here
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
