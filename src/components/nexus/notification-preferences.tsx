"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Bell,
  CalendarDays,
  BarChart3,
  Shield,
  Loader2,
  Check,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  useNotificationPrefs,
  useUpdateNotificationPrefs,
  type NotificationPrefs,
} from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";

const PREF_META: Array<{
  key: keyof NotificationPrefs;
  label: string;
  description: string;
  icon: typeof Bell;
}> = [
  {
    key: "eventReminders",
    label: "Event reminders",
    description: "Get notified before your classes start",
    icon: CalendarDays,
  },
  {
    key: "attendanceSummary",
    label: "Attendance summaries",
    description: "Receive updates when attendance is recorded",
    icon: BarChart3,
  },
  {
    key: "accountSecurity",
    label: "Security alerts",
    description: "Important account and login notifications",
    icon: Shield,
  },
];

export function NotificationPreferences() {
  const { data, isLoading } = useNotificationPrefs();
  const update = useUpdateNotificationPrefs();
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);

  useEffect(() => {
    if (data?.prefs) {
      // Sync local state when the server data changes (e.g. on first load
      // or after a mutation invalidates the query). Intentional setState
      // in effect — this is the standard "mirror server state locally" pattern.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPrefs(data.prefs);
    }
  }, [data]);

  const toggle = (key: keyof NotificationPrefs, value: boolean) => {
    if (!prefs) return;
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    update.mutate(next, {
      onSuccess: () => {
        toast({
          title: "Preferences saved",
          description: "Your notification settings have been updated.",
        });
      },
      onError: () => {
        // Revert on error
        setPrefs(prefs);
        toast({
          title: "Couldn't save",
          description: "Please try again.",
          variant: "destructive",
        });
      },
    });
  };

  if (isLoading || !prefs) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="h-4 w-4 text-primary" />
            Notification preferences
          </CardTitle>
          <CardDescription>Choose what you want to hear about</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="h-4 w-4 text-primary" />
            Notification preferences
          </CardTitle>
          <CardDescription>Choose what you want to hear about</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {PREF_META.map((meta, i) => {
            const Icon = meta.icon;
            const value = prefs[meta.key];
            return (
              <motion.div
                key={meta.key}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25, delay: i * 0.05 }}
                className="flex items-center gap-3 p-3 rounded-lg border border-border/50 hover:border-border transition-colors"
              >
                <div className="grid place-items-center h-9 w-9 rounded-lg bg-primary/10 text-primary shrink-0">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <Label className="text-sm font-medium cursor-pointer">
                    {meta.label}
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {meta.description}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {update.isPending && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  )}
                  {value && !update.isPending && (
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                  )}
                  <Switch
                    checked={value}
                    onCheckedChange={(v) => toggle(meta.key, v)}
                    disabled={update.isPending}
                  />
                </div>
              </motion.div>
            );
          })}
          <div className="pt-2">
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              Changes apply to future notifications
            </Badge>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
