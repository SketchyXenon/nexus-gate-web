"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CalendarDays,
  Plus,
  Trash2,
  Loader2,
  Globe,
  GraduationCap,
  CalendarX,
  Copy,
  Eye,
  Info,
  Search,
  SlidersHorizontal,
  X,
  Users,
  Clock,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useEvents,
  useEventsHistory,
  useCreateEvent,
  useDeleteEvent,
  useMe,
  type EventItem,
  type EventSort,
  type EventStatusFilter,
} from "@/lib/api-client";
import { PROGRAMS, getProgramLabel } from "@/lib/programs";
import { toast } from "@/hooks/use-toast";
import { useDebounce } from "@/hooks/use-debounce";
import { format } from "date-fns";
import { ConfirmDialog } from "@/components/nexus/confirm-dialog";
import { EventDetailsDialog } from "@/components/nexus/event-details-dialog";

// Sentinel values for the Radix Select (which rejects empty strings).
const SCOPE_ALL = "all";
const STATUS_ALL = "all";
const SORT_NEWEST = "newest";

interface FormErrors {
  title?: string;
  scheduledAt?: string;
}

export function EventsView() {
  const { data: me } = useMe();
  const isAdmin = me?.role === "ADMIN";

  // ---- Search / filter / sort state (all server-side) ----
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebounce(searchInput, 300);
  const [scopeFilter, setScopeFilter] = useState<string>(SCOPE_ALL);
  const [statusFilter, setStatusFilter] = useState<string>(STATUS_ALL);
  const [sortBy, setSortBy] = useState<EventSort>(SORT_NEWEST);

  // Build the params object for the events query. Only include non-default
  // values so React Query treats the cache key consistently.
  const eventsParams = {
    q: debouncedSearch.trim() || undefined,
    scope:
      scopeFilter === SCOPE_ALL
        ? undefined
        : (scopeFilter as "academic" | "departmental"),
    status:
      statusFilter === STATUS_ALL
        ? undefined
        : (statusFilter as EventStatusFilter),
    sort: sortBy,
  };

  const { data, isLoading, isFetching } = useEvents(eventsParams);
  const { data: historyData } = useEventsHistory();
  const create = useCreateEvent();
  const remove = useDeleteEvent();

  // ---- Create-event form state ----
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<"academic" | "departmental">("academic");
  // Program Select uses "__all__" sentinel (Radix Select rejects empty string)
  const [targetProgram, setTargetProgram] = useState("__all__");
  // Section field — text input, shown only when a program is selected.
  const [targetSection, setTargetSection] = useState("");
  const [delegatable, setDelegatable] = useState(true);
  // Separate date + time fields for better UX
  const [eventDate, setEventDate] = useState("");
  const [eventTime, setEventTime] = useState("08:00");
  const [endsAt, setEndsAt] = useState("");
  // Check-in window: separate date + time (defaults to event date)
  const [checkInOpensTime, setCheckInOpensTime] = useState("");
  const [checkInClosesTime, setCheckInClosesTime] = useState("");
  // Time-out window (only when enableTimeOut is true)
  const [enableTimeOut, setEnableTimeOut] = useState(false);
  const [timeOutOpensTime, setTimeOutOpensTime] = useState("");
  const [timeOutClosesTime, setTimeOutClosesTime] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [deleteTarget, setDeleteTarget] = useState<EventItem | null>(null);
  const [hardDeleteMode, setHardDeleteMode] = useState(false);
  const [detailsEventId, setDetailsEventId] = useState<number | null>(null);
  // Show-more pagination for past events (client-side, 5 at a time).
  const [pastEventsVisible, setPastEventsVisible] = useState(5);

  const events = data?.events ?? [];

  // Ended events (history) — only shown when the user is NOT actively
  // filtering to "ended" or "all" (otherwise it would duplicate what's
  // already in the main grid).
  const showPastSection = statusFilter === STATUS_ALL;
  const endedEvents = (historyData?.events ?? [])
    .filter(
      (e) =>
        e.timeStatus === "ended" &&
        !events.some((active) => active.id === e.id),
    )
    // When a search is active, also filter the past-events list by the same
    // query so the user doesn't see unrelated rows.
    .filter((e) => {
      const q = debouncedSearch.trim().toLowerCase();
      if (!q) return true;
      return e.title.toLowerCase().includes(q);
    });

  // The Section field is shown when a specific program is selected AND the
  // scope is "academic" (departmental events clear program/section anyway).
  const showSectionField = scope === "academic" && targetProgram !== "__all__";

  function validate(): boolean {
    const next: FormErrors = {};
    if (!title.trim()) {
      next.title = "Please enter a title for this event.";
    }
    if (!eventDate) {
      next.scheduledAt = "Please choose a date.";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function combineDateTime(date: string, time: string): string | undefined {
    if (!date || !time) return undefined;
    return new Date(`${date}T${time}`).toISOString();
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    const trimmedTitle = title.trim();
    const scheduledIso = combineDateTime(eventDate, eventTime)!;
    const checkInOpensIso = combineDateTime(eventDate, checkInOpensTime);
    const checkInClosesIso = combineDateTime(eventDate, checkInClosesTime);
    const timeOutOpensIso = enableTimeOut
      ? combineDateTime(eventDate, timeOutOpensTime)
      : undefined;
    const timeOutClosesIso = enableTimeOut
      ? combineDateTime(eventDate, timeOutClosesTime)
      : undefined;
    create.mutate(
      {
        title: trimmedTitle,
        scheduledAt: scheduledIso,
        endsAt: endsAt ? new Date(endsAt).toISOString() : undefined,
        checkInOpensAt: checkInOpensIso,
        checkInClosesAt: checkInClosesIso,
        timeOutOpensAt: timeOutOpensIso,
        timeOutClosesAt: timeOutClosesIso,
        enableTimeOut,
        description: description.trim() || undefined,
        scope,
        targetProgram:
          scope === "departmental" || targetProgram === "__all__"
            ? undefined
            : targetProgram,
        // Only send targetSection when a program is selected (academic scope)
        // and the user typed something. Empty string → undefined so the
        // server treats it as "all sections".
        targetSection:
          scope === "academic" &&
          targetProgram !== "__all__" &&
          targetSection.trim()
            ? targetSection.trim()
            : undefined,
        delegatable,
      },
      {
        onSuccess: () => {
          toast({
            title: "Event created",
            description: `"${trimmedTitle}" is ready for check-ins.`,
          });
          setTitle("");
          setDescription("");
          setScope("academic");
          setTargetProgram("__all__");
          setTargetSection("");
          setDelegatable(true);
          setEventDate("");
          setEventTime("08:00");
          setEndsAt("");
          setCheckInOpensTime("");
          setCheckInClosesTime("");
          setEnableTimeOut(false);
          setTimeOutOpensTime("");
          setTimeOutClosesTime("");
          setErrors({});
        },
        onError: (err) =>
          toast({
            title: "Could not create event",
            description: err.message,
            variant: "destructive",
          }),
      },
    );
  }

  // Duplicate an event's details into the create form (user picks a new
  // date/time — we never copy the scheduled time since it must be future).
  function handleDuplicate(e: EventItem) {
    setTitle(e.title);
    setDescription(e.description ?? "");
    setScope(e.scope);
    setTargetProgram(e.targetProgram ?? "__all__");
    setTargetSection(e.targetSection ?? "");
    setDelegatable(e.delegatable ?? true);
    setEventDate(format(new Date(e.scheduledAt), "yyyy-MM-dd"));
    setEventTime(format(new Date(e.scheduledAt), "HH:mm"));
    setCheckInOpensTime("");
    setCheckInClosesTime("");
    setEnableTimeOut(false);
    setTimeOutOpensTime("");
    setTimeOutClosesTime("");
    setErrors({});
    toast({
      title: "Event details copied",
      description:
        "The form is pre-filled. Pick a new date and time, then create.",
    });
    // Scroll to the form so the user sees the pre-filled values
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      if (hardDeleteMode) {
        await remove.mutateAsync({ id: deleteTarget.id, hard: true });
        toast({
          title: "Event permanently deleted",
          description: `"${deleteTarget.title}" and all its attendance records have been removed.`,
        });
      } else {
        await remove.mutateAsync({ id: deleteTarget.id });
        toast({
          title: "Event cancelled",
          description: `"${deleteTarget.title}" has been cancelled. Any attendance already recorded will stay.`,
        });
      }
    } catch (e) {
      toast({
        title: hardDeleteMode
          ? "Could not delete event"
          : "Could not cancel event",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  }

  // ---- Filter reset helper ----
  function clearFilters() {
    setSearchInput("");
    setScopeFilter(SCOPE_ALL);
    setStatusFilter(STATUS_ALL);
    setSortBy(SORT_NEWEST);
  }

  const hasActiveFilters =
    debouncedSearch.trim() !== "" ||
    scopeFilter !== SCOPE_ALL ||
    statusFilter !== STATUS_ALL ||
    sortBy !== SORT_NEWEST;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* ----------------------------- Create form ----------------------------- */}
      <Card className="lg:col-span-1 h-fit lg:sticky lg:top-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5 text-primary" />
            Add a new event
          </CardTitle>
          <CardDescription>
            Schedule a class, exam, or assembly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                placeholder="CS 101 — Data Structures"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (errors.title)
                    setErrors((p) => ({ ...p, title: undefined }));
                }}
                aria-invalid={!!errors.title}
              />
              {errors.title && (
                <p className="text-xs text-destructive">{errors.title}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                placeholder="Optional"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Scope</Label>
              <Select
                value={scope}
                onValueChange={(v) => setScope(v as typeof scope)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="academic">
                    <span className="flex items-center gap-2">
                      <GraduationCap className="h-4 w-4" /> One class or section
                    </span>
                  </SelectItem>
                  <SelectItem value="departmental">
                    <span className="flex items-center gap-2">
                      <Globe className="h-4 w-4" /> Whole department
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Program + Section — Section only appears when a program is
                selected AND scope is "academic". Departmental events clear
                program/section, so the Section field is hidden in that case. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="targetProgram">Program</Label>
                <Select
                  value={targetProgram}
                  onValueChange={(v) => {
                    setTargetProgram(v);
                    // Clear section if user switches back to "all programs"
                    if (v === "__all__") setTargetSection("");
                  }}
                  disabled={scope === "departmental"}
                >
                  <SelectTrigger className="w-full" aria-label="Target program">
                    <SelectValue placeholder="All programs" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All programs</SelectItem>
                    {PROGRAMS.map((p) => (
                      <SelectItem key={p.code} value={p.code}>
                        {p.code} — {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {showSectionField && (
                <div className="space-y-1.5">
                  <Label htmlFor="targetSection">
                    Section
                    <span className="text-xs font-normal text-muted-foreground ml-1">
                      (optional)
                    </span>
                  </Label>
                  <Input
                    id="targetSection"
                    placeholder="e.g. 1-A"
                    value={targetSection}
                    onChange={(e) => setTargetSection(e.target.value)}
                    maxLength={10}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Leave blank to target all sections in this program.
                  </p>
                </div>
              )}
            </div>

            {/* Date + Time — separate fields for clarity */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="eventDate">Date</Label>
                <Input
                  id="eventDate"
                  type="date"
                  value={eventDate}
                  onChange={(e) => {
                    setEventDate(e.target.value);
                    if (errors.scheduledAt)
                      setErrors((p) => ({ ...p, scheduledAt: undefined }));
                  }}
                  aria-invalid={!!errors.scheduledAt}
                />
                {errors.scheduledAt && (
                  <p className="text-xs text-destructive">
                    {errors.scheduledAt}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="eventTime">Start time</Label>
                <Input
                  id="eventTime"
                  type="time"
                  value={eventTime}
                  onChange={(e) => setEventTime(e.target.value)}
                />
              </div>
            </div>

            {/* Check-in window — time only (uses event date) */}
            <div className="space-y-2 rounded-lg border border-border/50 p-3 bg-muted/20">
              <p className="text-xs font-medium text-muted-foreground">
                Check-in window (optional)
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="ciOpens" className="text-[11px]">
                    Opens at
                  </Label>
                  <Input
                    id="ciOpens"
                    type="time"
                    value={checkInOpensTime}
                    onChange={(e) => setCheckInOpensTime(e.target.value)}
                    className="text-xs"
                    placeholder="e.g. 08:00"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ciCloses" className="text-[11px]">
                    Closes at
                  </Label>
                  <Input
                    id="ciCloses"
                    type="time"
                    value={checkInClosesTime}
                    onChange={(e) => setCheckInClosesTime(e.target.value)}
                    className="text-xs"
                    placeholder="e.g. 12:00"
                  />
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Leave blank for defaults.
              </p>
            </div>

            {/* Time-out toggle + window */}
            <label className="flex items-center gap-3 p-3 rounded-lg border border-border/50 bg-muted/20 cursor-pointer hover:bg-muted/40 transition-colors">
              <input
                type="checkbox"
                checked={enableTimeOut}
                onChange={(e) => setEnableTimeOut(e.target.checked)}
                className="h-4 w-4 rounded accent-primary"
              />
              <div className="flex-1 flex items-center gap-1.5">
                <p className="text-sm font-medium">Time-out mode</p>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    Students scan again to check out (e.g. 4:00 PM – 6:00 PM)
                  </TooltipContent>
                </Tooltip>
              </div>
            </label>
            {enableTimeOut && (
              <div className="space-y-2 rounded-lg border border-border/50 p-3 bg-muted/20">
                <p className="text-xs font-medium text-muted-foreground">
                  Time-out window
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="toOpens" className="text-[11px]">
                      Opens at
                    </Label>
                    <Input
                      id="toOpens"
                      type="time"
                      value={timeOutOpensTime}
                      onChange={(e) => setTimeOutOpensTime(e.target.value)}
                      className="text-xs"
                      placeholder="e.g. 16:00"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="toCloses" className="text-[11px]">
                      Closes at
                    </Label>
                    <Input
                      id="toCloses"
                      type="time"
                      value={timeOutClosesTime}
                      onChange={(e) => setTimeOutClosesTime(e.target.value)}
                      className="text-xs"
                      placeholder="e.g. 18:00"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* QR delegation toggle — lets other organizers in the same
                program project this event's QR code. */}
            <div
              className={`flex items-start gap-2 rounded-lg border border-border/50 p-3 bg-muted/20 ${
                scope === "departmental" ? "opacity-50" : ""
              }`}
            >
              <Checkbox
                id="delegatable"
                checked={delegatable}
                onCheckedChange={(v) => setDelegatable(v === true)}
                disabled={scope === "departmental"}
              />
              <div className="space-y-0.5">
                <Label
                  htmlFor="delegatable"
                  className="cursor-pointer text-sm flex items-center gap-1.5"
                >
                  Allow QR delegation
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent>
                      Other organizers in this program can project this event's
                      QR if you're absent
                    </TooltipContent>
                  </Tooltip>
                </Label>
              </div>
            </div>
            <Button
              type="submit"
              className="w-full"
              disabled={create.isPending}
            >
              {create.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Create event
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* ---------------------- Events list + toolbar ---------------------- */}
      <div className="lg:col-span-2 space-y-4">
        {/* Toolbar: search + filters + sort */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
              <CalendarDays className="h-5 w-5 text-primary" />
              All events
              <Badge variant="secondary" className="ml-1 tabular-nums">
                {events.length}
              </Badge>
              {isFetching && !isLoading && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              )}
            </CardTitle>
            <CardDescription className="hidden sm:block">
              Search by title, then narrow by scope, status, or sort order.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Unified toolbar: search + filters + sort in one consistent grid */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Search & filter
              </div>
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="h-7 text-xs shrink-0"
                >
                  <X className="h-3 w-3" />
                  Clear
                </Button>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              {/* Search */}
              <div className="relative sm:col-span-2 lg:col-span-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search events by title…"
                  className="pl-8 h-9"
                  aria-label="Search events"
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={() => setSearchInput("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 grid place-items-center h-5 w-5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Scope filter */}
              <Select value={scopeFilter} onValueChange={setScopeFilter}>
                <SelectTrigger
                  className="h-9 w-full"
                  aria-label="Filter by scope"
                >
                  <SelectValue placeholder="All scopes" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SCOPE_ALL}>All scopes</SelectItem>
                  <SelectItem value="academic">Academic</SelectItem>
                  <SelectItem value="departmental">Departmental</SelectItem>
                </SelectContent>
              </Select>

              {/* Status filter */}
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger
                  className="h-9 w-full"
                  aria-label="Filter by status"
                >
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={STATUS_ALL}>All statuses</SelectItem>
                  <SelectItem value="active">Active (live now)</SelectItem>
                  <SelectItem value="upcoming">Upcoming</SelectItem>
                  <SelectItem value="ended">Ended</SelectItem>
                </SelectContent>
              </Select>

              {/* Sort */}
              <Select
                value={sortBy}
                onValueChange={(v) => setSortBy(v as EventSort)}
              >
                <SelectTrigger className="h-9 w-full" aria-label="Sort by date">
                  <SelectValue placeholder="Sort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SORT_NEWEST}>Newest first</SelectItem>
                  <SelectItem value="oldest">Oldest first</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Events grid — 1 col mobile, 2 cols sm+ (within the right column) */}
        {isLoading ? (
          <Card>
            <CardContent className="p-8 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 mx-auto mb-2 animate-spin text-primary" />
              Loading events…
            </CardContent>
          </Card>
        ) : events.length === 0 ? (
          <Card>
            <CardContent className="p-10 text-center">
              <CalendarX className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
              <p className="text-sm font-medium">
                No events match your filters
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {hasActiveFilters
                  ? "Try clearing filters or adjusting your search."
                  : "Create one on the left to get started."}
              </p>
              {hasActiveFilters && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={clearFilters}
                  className="mt-3"
                >
                  Clear filters
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
            <AnimatePresence mode="popLayout">
              {events.map((e) => (
                <EventCard
                  key={e.id}
                  event={e}
                  onView={() => setDetailsEventId(e.id)}
                  onDuplicate={() => handleDuplicate(e)}
                  onDelete={() => {
                    setDeleteTarget(e);
                    setHardDeleteMode(false);
                  }}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* ----------------------- Past events section ----------------------- */}
      {showPastSection && endedEvents.length > 0 && (
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarX className="h-4 w-4 text-muted-foreground" />
              Past events ({endedEvents.length})
            </CardTitle>
            <CardDescription>
              These events have ended. Attendance records are preserved.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y">
              {endedEvents.slice(0, pastEventsVisible).map((e) => (
                <div
                  key={e.id}
                  className="px-4 sm:px-6 py-3 flex flex-wrap items-center gap-2 sm:gap-3 opacity-70 hover:opacity-100 hover:bg-muted/40 transition-all cursor-pointer group"
                  onClick={() => setDetailsEventId(e.id)}
                >
                  <div className="grid place-items-center h-9 w-9 rounded-lg bg-muted text-muted-foreground shrink-0">
                    <span className="text-xs font-semibold">
                      {format(new Date(e.scheduledAt), "dd")}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                      {e.title}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {format(new Date(e.scheduledAt), "PPp")} ·{" "}
                      {e._count?.attendances ?? 0} present
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className="border-muted text-muted-foreground shrink-0"
                  >
                    Ended
                  </Badge>
                  <div className="flex items-center shrink-0">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-muted-foreground hover:text-primary"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setDetailsEventId(e.id);
                          }}
                          aria-label={`View details for ${e.title}`}
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>View details</TooltipContent>
                    </Tooltip>
                    {isAdmin && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 text-muted-foreground hover:text-destructive"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setDeleteTarget(e);
                              setHardDeleteMode(true);
                            }}
                            aria-label={`Permanently delete ${e.title}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          Permanently delete (admin only)
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {endedEvents.length > pastEventsVisible && (
              <div className="p-3 text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPastEventsVisible((v) => v + 5)}
                >
                  Show more ({endedEvents.length - pastEventsVisible} remaining)
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) {
            setDeleteTarget(null);
            setHardDeleteMode(false);
          }
        }}
        destructive={true}
        title={
          hardDeleteMode
            ? "Permanently delete this event?"
            : "Cancel this event?"
        }
        description={
          hardDeleteMode
            ? `This will permanently delete "${deleteTarget?.title ?? ""}" and ALL attendance records for it. This cannot be undone.`
            : `This will cancel "${deleteTarget?.title ?? ""}". Students will no longer be able to check in. Any attendance already recorded will stay.`
        }
        confirmLabel={hardDeleteMode ? "Delete permanently" : "Cancel event"}
        cancelLabel={hardDeleteMode ? "Keep event" : "Keep event"}
        confirmText={hardDeleteMode ? "DELETE" : "CANCEL"}
        step2Warning={
          hardDeleteMode
            ? "All attendance records will be permanently lost."
            : "Students can no longer check in to this event."
        }
        onConfirm={handleDelete}
      />

      <EventDetailsDialog
        eventId={detailsEventId}
        open={detailsEventId !== null}
        onOpenChange={(o) => {
          if (!o) setDetailsEventId(null);
        }}
      />
    </div>
  );
}

// =========================================================================
// EventCard — single event in the responsive grid. Cards are kept a
// consistent size by using `h-full` + a fixed-height description area.
// =========================================================================
function EventCard({
  event,
  onView,
  onDuplicate,
  onDelete,
}: {
  event: EventItem;
  onView: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const scheduledAt = new Date(event.scheduledAt);
  const status: "live" | "upcoming" | "ended" | "cancelled" =
    (event.timeStatus as "live" | "upcoming" | "ended" | "cancelled") ??
    "upcoming";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25 }}
      className="h-full"
    >
      <Card className="h-full flex flex-col overflow-hidden hover:border-primary/40 transition-colors">
        <CardContent className="p-4 flex-1 flex flex-col gap-3">
          {/* Header: date chip + scope badge */}
          <div className="flex items-start gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="grid place-items-center h-11 w-11 rounded-lg bg-primary/10 text-primary shrink-0 cursor-default">
                  <span className="text-sm font-semibold tabular-nums">
                    {format(scheduledAt, "dd")}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent>{format(scheduledAt, "PPP")}</TooltipContent>
            </Tooltip>
            <div className="flex-1 min-w-0">
              <p className="font-medium leading-tight line-clamp-2 break-words">
                {event.title}
              </p>
              <div className="flex items-center gap-1.5 flex-wrap mt-1">
                <Badge
                  variant="outline"
                  className={
                    event.scope === "departmental"
                      ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
                      : "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                  }
                >
                  {event.scope === "departmental"
                    ? "Department-wide"
                    : "Academic"}
                </Badge>
                <StatusPill status={status} />
              </div>
            </div>
          </div>

          {/* Description (optional, line-clamped) */}
          {event.description && (
            <p className="text-xs text-muted-foreground line-clamp-2 break-words">
              {event.description}
            </p>
          )}

          {/* Meta: date/time + program + check-in windows */}
          <div className="text-xs text-muted-foreground space-y-1">
            <p className="flex items-center gap-1.5">
              <CalendarDays className="h-3 w-3 shrink-0" />
              <span className="truncate">
                {format(scheduledAt, "MMM d, yyyy")} ·{" "}
                {format(scheduledAt, "h:mm a")}
              </span>
            </p>
            <p className="flex items-center gap-1.5">
              <GraduationCap className="h-3 w-3 shrink-0" />
              <span className="truncate">
                {event.targetProgram
                  ? `${getProgramLabel(event.targetProgram) ?? event.targetProgram}${
                      event.targetSection ? ` · ${event.targetSection}` : ""
                    }`
                  : "All programs"}
              </span>
            </p>
            {event.checkInOpensAt && (
              <p className="flex items-center gap-1.5 text-emerald-600/80 dark:text-emerald-400/80">
                <Clock className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  Check-in: {format(new Date(event.checkInOpensAt), "h:mm a")} –{" "}
                  {format(
                    new Date(event.checkInClosesAt || event.scheduledAt),
                    "h:mm a",
                  )}
                </span>
              </p>
            )}
            {event.enableTimeOut && event.timeOutOpensAt && (
              <p className="flex items-center gap-1.5 text-amber-600/80 dark:text-amber-400/80">
                <Clock className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  Time-out: {format(new Date(event.timeOutOpensAt), "h:mm a")} –{" "}
                  {format(
                    new Date(event.timeOutClosesAt || event.scheduledAt),
                    "h:mm a",
                  )}
                </span>
              </p>
            )}
          </div>

          {/* Footer: attendance count + actions */}
          <div className="mt-auto pt-2 border-t border-border/60 flex items-center justify-between gap-2">
            <div className="flex items-center gap-3 text-xs text-muted-foreground min-w-0">
              <span className="flex items-center gap-1">
                <Users className="h-3.5 w-3.5" />
                <span className="font-semibold text-foreground tabular-nums">
                  {event._count?.attendances ?? 0}
                </span>
                <span className="hidden sm:inline">present</span>
              </span>
              {event.owner && (
                <span className="truncate hidden sm:inline">
                  by {event.owner.fullName}
                </span>
              )}
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-primary"
                    onClick={onView}
                    aria-label={`View details for ${event.title}`}
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>View details</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-primary"
                    onClick={onDuplicate}
                    aria-label={`Duplicate ${event.title}`}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Duplicate (copy to form)</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={onDelete}
                    aria-label={`Cancel event ${event.title}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Cancel this event</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ---- Status pill (live / upcoming / ended) ----
function StatusPill({
  status,
}: {
  status: "live" | "upcoming" | "ended" | "cancelled";
}) {
  if (status === "live") {
    return (
      <Badge className="bg-emerald-600 text-white hover:bg-emerald-600/90 gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
        Live
      </Badge>
    );
  }
  if (status === "upcoming") {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/50 text-amber-700 dark:text-amber-400"
      >
        Upcoming
      </Badge>
    );
  }
  if (status === "ended") {
    return <Badge variant="secondary">Ended</Badge>;
  }
  return <Badge variant="destructive">Cancelled</Badge>;
}
