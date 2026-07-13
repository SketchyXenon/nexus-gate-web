"use client";

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, CalendarDays, CircleDot, Clock, X, Download, CalendarPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEvents, type EventItem } from "@/lib/api-client";
import { getProgramLabel } from "@/lib/programs";
import { getTimeStatus } from "@/lib/event-time";
import { downloadIcsFile, downloadBulkIcsFile } from "@/lib/ics-export";
import { toast } from "@/hooks/use-toast";
import { format, isSameDay, isSameMonth, startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval, addMonths, parseISO } from "date-fns";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Convert EventItem (string dates from API) to the Date shape getTimeStatus expects.
const toTimeEvent = (e: EventItem) => ({
  scheduledAt: parseISO(e.scheduledAt),
  endsAt: e.endsAt ? parseISO(e.endsAt) : null,
  checkInOpensAt: e.checkInOpensAt ? parseISO(e.checkInOpensAt) : null,
  checkInClosesAt: e.checkInClosesAt ? parseISO(e.checkInClosesAt) : null,
  timeOutOpensAt: e.timeOutOpensAt ? parseISO(e.timeOutOpensAt) : null,
  timeOutClosesAt: e.timeOutClosesAt ? parseISO(e.timeOutClosesAt) : null,
  enableTimeOut: e.enableTimeOut ?? false,
  status: e.status,
});

const timeStatusColor = (status: string): string => {
  switch (status) {
    case "live": return "bg-emerald-500";
    case "upcoming": return "bg-amber-500";
    case "ended": return "bg-muted-foreground/40";
    default: return "bg-red-500";
  }
};

const timeStatusLabel = (status: string): string => {
  switch (status) {
    case "live": return "Live now";
    case "upcoming": return "Upcoming";
    case "ended": return "Ended";
    default: return "Cancelled";
  }
};

export function CalendarView() {
  const [cursor, setCursor] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);

  // Fetch all events (including ended) for the calendar.
  const { data, isLoading } = useEvents({ includeEnded: true, status: "all", sort: "oldest" });

  const events = data?.events ?? [];

  // Group events by date (YYYY-MM-DD key).
  const eventsByDate = useMemo(() => {
    const map = new Map<string, EventItem[]>();
    for (const e of events) {
      try {
        const key = format(parseISO(e.scheduledAt), "yyyy-MM-dd");
        const list = map.get(key) ?? [];
        list.push(e);
        map.set(key, list);
      } catch {
        // skip malformed dates
      }
    }
    return map;
  }, [events]);

  // Build the calendar grid: 6 weeks starting from Sunday.
  const days = useMemo(() => {
    const monthStart = startOfMonth(cursor);
    const monthEnd = endOfMonth(cursor);
    const gridStart = startOfWeek(monthStart);
    const gridEnd = endOfWeek(monthEnd);
    return eachDayOfInterval({ start: gridStart, end: gridEnd });
  }, [cursor]);

  const today = new Date();
  const monthLabel = format(cursor, "MMMM yyyy");
  const prevMonth = () => setCursor((d) => addMonths(d, -1));
  const nextMonth = () => setCursor((d) => addMonths(d, 1));
  const goToday = () => setCursor(new Date());

  // Events for the selected day (in the modal).
  const selectedDayEvents = selectedDay
    ? eventsByDate.get(format(selectedDay, "yyyy-MM-dd")) ?? []
    : [];

  return (
    <div className="space-y-4">
      {/* Header with month navigation */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                <CalendarDays className="h-4 w-4 text-primary" />
                {monthLabel}
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                {events.length} event{events.length === 1 ? "" : "s"} across all months
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="sm" className="h-8" onClick={prevMonth}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" className="h-8 px-3" onClick={goToday}>
                Today
              </Button>
              <Button variant="outline" size="sm" className="h-8" onClick={nextMonth}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              {events.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5"
                  onClick={() => {
                    downloadBulkIcsFile(
                      events.map((e) => ({
                        title: e.title,
                        description: e.description,
                        scheduledAt: e.scheduledAt,
                        endsAt: e.endsAt,
                      })),
                      `nexus-gate-events-${format(new Date(), "yyyy-MM-dd")}.ics`,
                    );
                    toast({
                      title: "Calendar exported",
                      description: `${events.length} events downloaded as .ics`,
                    });
                  }}
                >
                  <Download className="h-3.5 w-3.5" />
                  Export all
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-2 sm:p-4 sm:pt-0">
          {isLoading ? (
            <Skeleton className="h-96 rounded-lg" />
          ) : (
            <>
              {/* Weekday headers */}
              <div className="grid grid-cols-7 gap-1 sm:gap-2 mb-1">
                {WEEKDAYS.map((d) => (
                  <div
                    key={d}
                    className="text-center text-[10px] sm:text-xs font-semibold text-muted-foreground uppercase tracking-wide py-1"
                  >
                    {d}
                  </div>
                ))}
              </div>
              {/* Calendar grid */}
              <div className="grid grid-cols-7 gap-1 sm:gap-2">
                {days.map((day) => {
                  const inMonth = isSameMonth(day, cursor);
                  const isToday = isSameDay(day, today);
                  const dayEvents = eventsByDate.get(format(day, "yyyy-MM-dd")) ?? [];
                  const hasEvents = dayEvents.length > 0;
                  return (
                    <motion.button
                      key={day.toISOString()}
                      whileTap={{ scale: 0.96 }}
                      onClick={() => hasEvents && setSelectedDay(day)}
                      disabled={!hasEvents}
                      className={`
                        relative aspect-square sm:aspect-[4/3] rounded-lg border p-1 sm:p-1.5
                        flex flex-col items-start gap-0.5 text-left transition-colors
                        ${inMonth ? "bg-card" : "bg-muted/30 opacity-50"}
                        ${isToday ? "border-primary/50 ring-1 ring-primary/20" : "border-border/50"}
                        ${hasEvents ? "hover:border-primary/40 hover:bg-accent/40 cursor-pointer" : "cursor-default"}
                      `}
                    >
                      <span
                        className={`
                          text-[10px] sm:text-xs font-medium leading-none
                          ${isToday ? "text-primary font-bold" : inMonth ? "text-foreground" : "text-muted-foreground"}
                        `}
                      >
                        {format(day, "d")}
                      </span>
                      {hasEvents && (
                        <div className="flex flex-wrap gap-0.5 mt-auto w-full">
                          {dayEvents.slice(0, 3).map((e) => {
                            const status = getTimeStatus(toTimeEvent(e));
                            return (
                              <span
                                key={e.id}
                                className={`h-1.5 w-1.5 rounded-full ${timeStatusColor(status)}`}
                                title={e.title}
                              />
                            );
                          })}
                          {dayEvents.length > 3 && (
                            <span className="text-[8px] text-muted-foreground font-medium leading-none self-center">
                              +{dayEvents.length - 3}
                            </span>
                          )}
                        </div>
                      )}
                    </motion.button>
                  );
                })}
              </div>

              {/* Legend */}
              <div className="flex items-center gap-4 mt-4 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="text-[11px] text-muted-foreground">Live</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  <span className="text-[11px] text-muted-foreground">Upcoming</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
                  <span className="text-[11px] text-muted-foreground">Ended</span>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Day events dialog */}
      <Dialog open={!!selectedDay} onOpenChange={(o) => !o && setSelectedDay(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-primary" />
              {selectedDay ? format(selectedDay, "EEEE, MMMM d, yyyy") : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 max-h-96 overflow-y-auto ng-scroll">
            {selectedDayEvents.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                No events on this day.
              </p>
            )}
            <AnimatePresence mode="popLayout">
              {selectedDayEvents.map((e, i) => {
                const status = getTimeStatus(toTimeEvent(e));
                const scheduled = parseISO(e.scheduledAt);
                return (
                  <motion.div
                    key={e.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.2, delay: i * 0.04 }}
                    className="flex items-start gap-3 p-3 rounded-lg border bg-card hover:bg-accent/30 transition-colors group"
                  >
                    <div className="grid place-items-center h-9 w-9 rounded-lg bg-primary/10 text-primary shrink-0">
                      <CircleDot className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{e.title}</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Clock className="h-3 w-3" />
                        {format(scheduled, "h:mm a")}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {e.targetProgram
                          ? (getProgramLabel(e.targetProgram) ?? e.targetProgram)
                          : "All programs"}
                        {e.targetSection ? ` · ${e.targetSection}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${
                          status === "live"
                            ? "border-emerald-500/40 text-emerald-600"
                            : status === "upcoming"
                            ? "border-amber-500/40 text-amber-600"
                            : status === "ended"
                            ? "border-muted text-muted-foreground"
                            : "border-red-500/40 text-red-600"
                        }`}
                      >
                        {timeStatusLabel(status)}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => {
                          downloadIcsFile({
                            title: e.title,
                            description: e.description,
                            scheduledAt: e.scheduledAt,
                            endsAt: e.endsAt,
                          });
                          toast({ title: "Event added to calendar", description: `"${e.title}" downloaded as .ics` });
                        }}
                        aria-label={`Add ${e.title} to calendar`}
                      >
                        <CalendarPlus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
