"use client";

import { useEffect, useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import {
  AlertTriangle,
  Plus,
  Loader2,
  UserPlus,
  History,
  Info,
  CheckCircle2,
  XCircle,
  Search,
  X,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  ShieldAlert,
  CloudOff,
  Fingerprint,
  RotateCcw,
  Trash2,
  Clock,
  CheckCheck,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EventCombobox } from "@/components/nexus/event-combobox";
import { ConfirmDialog } from "@/components/nexus/confirm-dialog";
import {
  useEvents,
  useWhitelist,
  useEventAttendance,
  useOverrides,
  type Account,
  type EventItem,
  type OverrideRow,
} from "@/lib/api-client";
import {
  createOverrideCertificate,
  type OverrideCertificate,
} from "@/lib/override-certificate";
import {
  getOrCreateDeviceKeyPair,
  registerDeviceKeyWithServer,
  signOverrideCertificate,
} from "@/lib/device-key-client";
import { useOverrideQueue } from "@/hooks/use-override-queue";
import { useDebounce } from "@/hooks/use-debounce";
import { toast } from "@/hooks/use-toast";

const SELECT_NONE = "NONE";
const DEFAULT_REASON = "Couldn't scan - missing or broken phone";
const PAGE_SIZE = 25;

// Offline caches (stale-while-offline): the last successful fetch is
// persisted so the create form still works with zero connectivity.
// The events cache is account-scoped; the whitelist cache is per event.
const EVENTS_CACHE_PREFIX = "ng_ovr_events";
const WHITELIST_CACHE_PREFIX = "ng_ovr_wl";

function cacheGet<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function cacheSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota */
  }
}

interface WhitelistStudent {
  studentId: number;
  fullName: string;
  program: string | null;
  section: string | null;
}

export function OverridesView({ currentUser }: { currentUser: Account }) {
  // ============================================================
  //  Form state (Create Override)
  // ============================================================
  const { data: eventsData } = useEvents();
  const allEvents = eventsData?.events ?? [];

  // Organizers can only create overrides for events they OWN (the server
  // enforces this too - the filter is UX, not security). Admins see all.
  const myEvents = useMemo(
    () =>
      currentUser.role === "ADMIN"
        ? allEvents
        : allEvents.filter((e) => e.ownerId === currentUser.id),
    [allEvents, currentUser.id, currentUser.role],
  );

  // Offline fallback: the last-known owned/all events list.
  const eventsCacheKey = `${EVENTS_CACHE_PREFIX}:${currentUser.id}`;
  const events: EventItem[] = useMemo(
    () =>
      myEvents.length > 0
        ? myEvents
        : (cacheGet<EventItem[]>(eventsCacheKey) ?? []),
    [myEvents, eventsCacheKey],
  );
  useEffect(() => {
    if (myEvents.length > 0) cacheSet(eventsCacheKey, myEvents);
  }, [myEvents, eventsCacheKey]);

  const [formEventId, setFormEventId] = useState<number | null>(null);
  // `formEventId` is null until events load - derived default uses the first
  // event. We don't need an effect for the default.
  const effectiveFormEventId: number | null =
    formEventId ?? events[0]?.id ?? null;
  const event = events.find((e) => e.id === effectiveFormEventId);

  const [selectedStudentId, setSelectedStudentId] =
    useState<string>(SELECT_NONE);
  const [reason, setReason] = useState(DEFAULT_REASON);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // ---- Offline-first sync queue (signed certificates) ----
  const { queue, online, enqueueSigned, retryItem, clearSynced, removeItem } =
    useOverrideQueue(currentUser.id);

  // Register this device's Ed25519 key in the background so the first
  // override doesn't pay the registration round-trip (same pattern as the
  // student scanner). Idempotent - a no-op when already registered.
  useEffect(() => {
    registerDeviceKeyWithServer(currentUser.id).catch(() => {});
  }, [currentUser.id]);

  // List state
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebounce(searchInput, 300);
  const [listEventId, setListEventId] = useState<number | null>(null);
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [page, setPage] = useState(1);

  // Whitelist (filtered by event's program/section) + existing attendance
  // for the form's selected event - used to compute the "missing students"
  // list shown in the student picker.
  const isDeptWide = !event?.targetProgram && !event?.targetSection;
  const whitelistQ = useWhitelist({
    program: event?.targetProgram || undefined,
    section: event?.targetSection || undefined,
    pageSize: 500,
    // Only fetch once an event is selected.
    enabled: effectiveFormEventId != null,
  });
  const whitelistCacheKey = effectiveFormEventId
    ? `${WHITELIST_CACHE_PREFIX}:${effectiveFormEventId}`
    : null;

  // Online: live whitelist data. Offline: last-cached snapshot (the
  // presence list is unknowable offline - the picker then shows everyone).
  const onlineWhitelist = whitelistQ.data?.students ?? [];
  useEffect(() => {
    if (onlineWhitelist.length > 0 && whitelistCacheKey) {
      cacheSet(whitelistCacheKey, onlineWhitelist);
    }
  }, [onlineWhitelist, whitelistCacheKey]);
  const whitelist: WhitelistStudent[] = useMemo(() => {
    if (online) return onlineWhitelist;
    return whitelistCacheKey
      ? (cacheGet<WhitelistStudent[]>(whitelistCacheKey) ?? [])
      : [];
  }, [online, onlineWhitelist, whitelistCacheKey]);

  // Disable 4s polling - a snapshot of who's present is enough here.
  const presenceQ = useEventAttendance(effectiveFormEventId, { poll: false });

  const presentIds = useMemo(
    () =>
      new Set(
        (presenceQ.data?.attendances ?? [])
          .map((a) => a.account.studentId)
          .filter((v): v is number => v != null),
      ),
    [presenceQ.data],
  );
  // When offline we can't know who's already present - offer the full
  // whitelist and let the server's unique constraint resolve duplicates
  // at sync (surfaced as a friendly "already recorded" result).
  const missingStudents = useMemo(
    () =>
      online
        ? whitelist.filter((s) => !presentIds.has(s.studentId))
        : whitelist,
    [whitelist, presentIds, online],
  );
  const allPresent =
    online &&
    !whitelistQ.isLoading &&
    !presenceQ.isLoading &&
    whitelist.length > 0 &&
    missingStudents.length === 0;

  const selectedStudent = missingStudents.find(
    (s) => String(s.studentId) === selectedStudentId,
  );

  // Soft client-side window hint. The SERVER is the source of truth (it
  // validates the signed creation timestamp against the event window);
  // this only prevents obviously-futile submissions.
  const eventEnded =
    event?.timeStatus === "ended" || event?.timeStatus === "cancelled";

  // ============================================================
  //  List state (Recent Manual Entries)
  // ============================================================
  const overridesQ = useOverrides({
    page,
    pageSize: PAGE_SIZE,
    eventId: listEventId ?? undefined,
    q: debouncedSearch || undefined,
    from: fromDate ? new Date(fromDate).toISOString() : undefined,
    to: toDate ? new Date(`${toDate}T23:59:59`).toISOString() : undefined,
  });

  const overrides: OverrideRow[] = overridesQ.data?.overrides ?? [];
  const pagination = overridesQ.data?.pagination;

  const hasListFilters =
    debouncedSearch !== "" ||
    listEventId != null ||
    fromDate !== "" ||
    toDate !== "";

  function clearListFilters() {
    setSearchInput("");
    setListEventId(null);
    setFromDate("");
    setToDate("");
    setPage(1);
  }

  // Wrap each filter setter so that changing a filter also resets the page
  // to 1 (avoids landing on an empty page after a filter narrows results).
  function changeSearch(v: string) {
    setSearchInput(v);
    setPage(1);
  }
  function changeListEvent(id: number | null) {
    setListEventId(id);
    setPage(1);
  }
  function changeFromDate(v: string) {
    setFromDate(v);
    setPage(1);
  }
  function changeToDate(v: string) {
    setToDate(v);
    setPage(1);
  }

  // ============================================================
  //  Form actions
  // ============================================================
  function tryOpenConfirm() {
    setFormError(null);
    if (!effectiveFormEventId) {
      setFormError("Please pick an event first.");
      return;
    }
    if (selectedStudentId === SELECT_NONE) {
      setFormError("Please pick a student from the list.");
      return;
    }
    if (!reason.trim()) {
      setFormError(
        "Please add a short reason so there's a record of what happened.",
      );
      return;
    }
    setConfirmOpen(true);
  }

  // Signs the override certificate with this device's Ed25519 key and
  // enqueues it. Online: syncs within ~1s. Offline: drains automatically
  // when connectivity returns. Either way there is ONE code path - the
  // certificate is created and signed at the moment the organizer
  // confirms, which is what the server's window validation checks.
  async function submitOverride() {
    if (!effectiveFormEventId || selectedStudentId === SELECT_NONE) return;
    setSubmitting(true);
    try {
      // Ensure the device key is registered (idempotent; near-instant when
      // already registered thanks to the mount-time background call).
      const registered = await registerDeviceKeyWithServer(currentUser.id);
      if (!registered) {
        throw new Error(
          "This device couldn't be registered for signing. Check your connection and try again.",
        );
      }
      const keyPair = await getOrCreateDeviceKeyPair(currentUser.id);
      const cert: OverrideCertificate = createOverrideCertificate({
        eventId: effectiveFormEventId,
        studentId: Number(selectedStudentId),
        reason: reason.trim(),
        deviceFingerprint: keyPair.fingerprint,
      });
      const signed = await signOverrideCertificate(cert, currentUser.id);
      enqueueSigned(signed, {
        eventTitle: event?.title ?? "Event",
        studentName: selectedStudent?.fullName ?? "Student",
      });
      toast({
        title: online ? "Student marked as present" : "Saved offline",
        description: online
          ? "The manual entry has been saved with your name and this device's signature."
          : "The entry is signed and queued on this device. It will sync automatically when you reconnect.",
      });
      setSelectedStudentId(SELECT_NONE);
      setReason(DEFAULT_REASON);
    } catch (e) {
      toast({
        title: "Couldn't save the manual entry",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  // ============================================================
  //  Render
  // ============================================================
  return (
    <div className="grid gap-6 lg:grid-cols-3 min-w-0">
      {/* ============== CREATE OVERRIDE FORM ============== */}
      <div className="h-fit lg:col-span-1 min-w-0 space-y-6">
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-primary" />
              Add Student Manually
            </CardTitle>
            <CardDescription>
              Use this only when a student couldn&apos;t scan their QR code.
              Works offline.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md bg-amber-500/10 border border-amber-500/30 p-3 text-xs text-amber-700 dark:text-amber-400 flex gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <p>
                This skips the QR scan and marks the student as present. Each
                entry is{" "}
                <strong>cryptographically signed by this device</strong> and
                recorded with your name, the time you made it, and whether it
                synced late - so use it only when the student really
                couldn&apos;t scan.
              </p>
            </div>

            {/* Offline banner */}
            {!online && (
              <div className="rounded-md bg-muted border p-3 text-xs flex gap-2 items-start">
                <CloudOff className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                <p className="text-muted-foreground">
                  You&apos;re offline. Entries you add now are signed and stored
                  on this device, then sync automatically when you reconnect
                  (within 24 hours).
                </p>
              </div>
            )}

            {/* Event picker - searchable combobox (handles many events) */}
            <div className="space-y-1.5">
              <Label htmlFor="ovr-event" className="text-xs">
                Event
              </Label>
              <EventCombobox
                events={events}
                value={effectiveFormEventId}
                onChange={(id) => {
                  setFormEventId(id);
                  setSelectedStudentId(SELECT_NONE);
                  setFormError(null);
                }}
                placeholder="Select an event…"
              />
              {currentUser.role !== "ADMIN" && (
                <p className="text-[11px] text-muted-foreground">
                  Only events you organize are listed.
                </p>
              )}
              {event && (
                <p className="text-[11px] text-muted-foreground">
                  {isDeptWide
                    ? "Department-wide event - showing all students."
                    : `Showing students in ${event.targetProgram ?? "all programs"}${event.targetSection ? `, section ${event.targetSection}` : ""}.`}
                </p>
              )}
              {eventEnded && (
                <p className="text-xs text-amber-600 flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" />
                  This event&apos;s windows have closed - new entries will be
                  rejected at sync.
                </p>
              )}
            </div>

            {/* Student picker */}
            <div className="space-y-1.5">
              <Label htmlFor="ovr-student" className="text-xs">
                Student to add
              </Label>
              <Select
                value={selectedStudentId}
                onValueChange={(v) => {
                  setSelectedStudentId(v);
                  setFormError(null);
                }}
                disabled={!effectiveFormEventId}
              >
                <SelectTrigger id="ovr-student" className="h-10 w-full">
                  <SelectValue
                    placeholder={
                      online
                        ? "Pick a student who hasn't checked in…"
                        : "Pick a student…"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {online && whitelistQ.isLoading && (
                    <SelectItem value={SELECT_NONE} disabled>
                      Loading students…
                    </SelectItem>
                  )}
                  {online &&
                    !whitelistQ.isLoading &&
                    missingStudents.length === 0 &&
                    !allPresent && (
                      <SelectItem value={SELECT_NONE} disabled>
                        No eligible students found
                      </SelectItem>
                    )}
                  {allPresent && (
                    <SelectItem value={SELECT_NONE} disabled>
                      Everyone is already present
                    </SelectItem>
                  )}
                  {!online && whitelist.length === 0 && (
                    <SelectItem value={SELECT_NONE} disabled>
                      No cached student list - reconnect once
                    </SelectItem>
                  )}
                  {missingStudents.map((s) => (
                    <SelectItem key={s.studentId} value={String(s.studentId)}>
                      {s.fullName} · {s.studentId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {effectiveFormEventId != null && allPresent && (
                <p className="text-xs text-emerald-600 flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  All eligible students are already present.
                </p>
              )}
              {effectiveFormEventId != null &&
                online &&
                !whitelistQ.isLoading &&
                !allPresent &&
                whitelist.length === 0 && (
                  <p className="text-xs text-amber-600 flex items-center gap-1.5">
                    <Info className="h-3.5 w-3.5" />
                    No students found for this event&apos;s program/section.
                    Import students first.
                  </p>
                )}
              {!online && whitelist.length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Offline - showing the cached roster. Attendance is unknown,
                  and duplicates are safely rejected at sync.
                </p>
              )}
            </div>

            {/* Reason */}
            <div className="space-y-1.5">
              <Label htmlFor="ovr-reason" className="text-xs">
                Reason
              </Label>
              <Textarea
                id="ovr-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="e.g. Phone battery died, no camera, etc."
                className="text-sm"
              />
            </div>

            {formError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive flex gap-2">
                <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <p>{formError}</p>
              </div>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="w-full h-11"
                  onClick={tryOpenConfirm}
                  disabled={
                    !effectiveFormEventId ||
                    selectedStudentId === SELECT_NONE ||
                    submitting ||
                    eventEnded
                  }
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  Mark student as present
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {eventEnded
                  ? "This event's windows have closed."
                  : online
                    ? "You'll be asked to confirm before the entry is saved."
                    : "You'll be asked to confirm; the entry syncs when you reconnect."}
              </TooltipContent>
            </Tooltip>

            {selectedStudent && (
              <div className="rounded-md bg-muted/40 p-3 text-xs">
                <p className="text-muted-foreground">About to mark present:</p>
                <p className="font-medium mt-0.5">{selectedStudent.fullName}</p>
                <p className="text-muted-foreground">
                  Student ID {selectedStudent.studentId} ·{" "}
                  {selectedStudent.program} {selectedStudent.section}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ============== SYNC QUEUE ============== */}
        {queue.length > 0 && (
          <Card className="overflow-hidden">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between gap-2 text-base">
                <span className="flex items-center gap-2">
                  <Fingerprint className="h-4 w-4 text-primary" />
                  Sync queue
                </span>
                <span className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className={
                      online
                        ? "border-emerald-500/40 text-emerald-600 text-[10px]"
                        : "border-amber-500/40 text-amber-600 text-[10px]"
                    }
                  >
                    {online ? "Online" : "Offline"}
                  </Badge>
                  {queue.some((q) => q.status === "synced") && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={clearSynced}
                    >
                      <CheckCheck className="h-3 w-3" />
                      Clear synced
                    </Button>
                  )}
                </span>
              </CardTitle>
              <CardDescription>
                {queue.filter((q) => q.status !== "synced").length > 0
                  ? `${queue.filter((q) => q.status !== "synced").length} entr${queue.filter((q) => q.status !== "synced").length === 1 ? "y" : "ies"} waiting to sync`
                  : "All entries synced"}
                {" · signed by this device"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 max-h-72 overflow-y-auto ng-scroll">
              <AnimatePresence initial={false}>
                {queue.map((item) => (
                  <motion.div
                    key={item.id}
                    layout
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="rounded-md border p-2.5 text-xs space-y-1.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium truncate">
                          {item.studentName}
                        </p>
                        <p className="text-muted-foreground truncate">
                          {item.eventTitle}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {item.status === "pending" && (
                          <Badge
                            variant="outline"
                            className="text-[10px] gap-1 border-amber-500/40 text-amber-600"
                          >
                            <Clock className="h-2.5 w-2.5" />
                            {online ? "Syncing soon" : "Waiting"}
                          </Badge>
                        )}
                        {item.status === "syncing" && (
                          <Badge
                            variant="outline"
                            className="text-[10px] gap-1"
                          >
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            Syncing
                          </Badge>
                        )}
                        {item.status === "synced" && (
                          <Badge
                            variant="outline"
                            className="text-[10px] gap-1 border-emerald-500/40 text-emerald-600"
                          >
                            <CheckCircle2 className="h-2.5 w-2.5" />
                            Synced
                          </Badge>
                        )}
                        {item.status === "failed" && (
                          <Badge
                            variant="outline"
                            className="text-[10px] gap-1 border-destructive/40 text-destructive"
                          >
                            <XCircle className="h-2.5 w-2.5" />
                            Failed
                          </Badge>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                          onClick={() => removeItem(item.id)}
                          aria-label="Remove from queue"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                    {item.status === "synced" && item.result?.message && (
                      <p className="text-[11px] text-emerald-600 flex items-start gap-1.5">
                        <CheckCircle2 className="h-3 w-3 shrink-0 mt-0.5" />
                        {item.result.message}
                      </p>
                    )}
                    {item.status === "failed" && item.error && (
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-[11px] text-destructive flex items-start gap-1.5 min-w-0">
                          <XCircle className="h-3 w-3 shrink-0 mt-0.5" />
                          <span className="break-words">{item.error}</span>
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-[10px] shrink-0 gap-1"
                          onClick={() => retryItem(item.id)}
                        >
                          <RotateCcw className="h-3 w-3" />
                          Retry
                        </Button>
                      </div>
                    )}
                    {item.status === "pending" &&
                      item.attempts > 0 &&
                      item.error && (
                        <p className="text-[11px] text-muted-foreground">
                          Attempt {item.attempts}: {item.error}
                        </p>
                      )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ============== RECENT MANUAL ENTRIES LIST ============== */}
      <Card className="lg:col-span-2 flex flex-col min-w-0 overflow-hidden">
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2">
                <History className="h-5 w-5 text-primary" />
                Recent Manual Entries
              </CardTitle>
              <CardDescription>
                {pagination?.total != null
                  ? `${pagination.total} manual entr${pagination.total === 1 ? "y" : "ies"} ${listEventId != null ? "for this event" : "across all your events"}`
                  : "Loading entries…"}
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        {/* Filter / search toolbar */}
        <CardContent className="border-b space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Filter entries
            </div>
            {hasListFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearListFilters}
                className="h-7 text-xs shrink-0"
              >
                <X className="h-3 w-3" />
                Clear
              </Button>
            )}
          </div>
          {/* Unified grid: 1 col mobile, 2 cols sm, 4 cols lg (date range gets 2 cols) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {/* Search */}
            <div className="relative sm:col-span-2 lg:col-span-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search name, ID, or reason…"
                value={searchInput}
                onChange={(e) => changeSearch(e.target.value)}
                className="pl-8 h-9"
                aria-label="Search overrides"
              />
            </div>

            {/* Event filter (searchable combobox with "All events") */}
            <div className="sm:col-span-2 lg:col-span-1">
              <EventCombobox
                events={events}
                value={listEventId}
                onChange={changeListEvent}
                placeholder="All events"
                allowClear
                allLabel="All events"
                showDate={false}
              />
            </div>

            {/* Date range - two inputs side by side, spans 2 cols on desktop */}
            <div className="flex items-center gap-1.5 sm:col-span-2 lg:col-span-2">
              <div className="relative flex-1 min-w-0">
                <CalendarRange className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  type="date"
                  value={fromDate}
                  onChange={(e) => changeFromDate(e.target.value)}
                  className="pl-8 h-9 text-xs w-full"
                  aria-label="Filter from date"
                />
              </div>
              <span className="text-muted-foreground text-xs shrink-0">to</span>
              <div className="relative flex-1 min-w-0">
                <CalendarRange className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  type="date"
                  value={toDate}
                  onChange={(e) => changeToDate(e.target.value)}
                  className="pl-8 h-9 text-xs w-full"
                  aria-label="Filter to date"
                />
              </div>
            </div>
          </div>
        </CardContent>

        {/* Overrides list */}
        <CardContent className="p-0 flex-1">
          {overridesQ.isLoading && (
            <div className="p-10 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
              Loading manual entries…
            </div>
          )}

          {overridesQ.isError && (
            <div className="p-6 text-center text-sm text-destructive flex flex-col items-center gap-2">
              <ShieldAlert className="h-6 w-6" />
              <p>Couldn&apos;t load manual entries. Please try again.</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => overridesQ.refetch()}
              >
                Retry
              </Button>
            </div>
          )}

          {!overridesQ.isLoading &&
            !overridesQ.isError &&
            overrides.length === 0 && (
              <div className="p-10 text-center text-sm text-muted-foreground">
                <Info className="h-6 w-6 mx-auto mb-2 opacity-50" />
                {hasListFilters
                  ? "No manual entries match your filters."
                  : "No manual entries yet. Entries you create will appear here."}
              </div>
            )}

          {!overridesQ.isLoading &&
            !overridesQ.isError &&
            overrides.length > 0 && (
              <>
                {/* Desktop / tablet: horizontal-scroll table */}
                <div className="overflow-x-auto ng-scroll">
                  <Table>
                    <TableHeader className="bg-card">
                      <TableRow>
                        <TableHead className="min-w-[12rem]">Student</TableHead>
                        <TableHead className="min-w-[10rem]">Event</TableHead>
                        <TableHead className="min-w-[14rem]">Reason</TableHead>
                        <TableHead className="min-w-[9rem]">When</TableHead>
                        <TableHead className="min-w-[9rem]">By</TableHead>
                        <TableHead className="min-w-[6rem]">Source</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <AnimatePresence initial={false}>
                        {overrides.map((o) => (
                          <motion.tr
                            key={o.id}
                            layout
                            initial={{ opacity: 0, y: -8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            className="hover:bg-muted/40 min-h-[44px]"
                          >
                            <TableCell className="min-h-[44px] py-3">
                              <div className="flex flex-col">
                                <span className="text-sm font-medium">
                                  {o.student.fullName}
                                </span>
                                <span className="text-xs text-muted-foreground font-mono">
                                  ID #{o.student.studentId}
                                </span>
                                <span className="text-[11px] text-muted-foreground">
                                  {o.student.program} {o.student.section}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="py-3">
                              <div className="flex flex-col">
                                <span className="text-sm truncate max-w-[14rem]">
                                  {o.event.title}
                                </span>
                                <span className="text-[11px] text-muted-foreground">
                                  {format(
                                    parseISO(o.event.scheduledAt),
                                    "MMM d, yyyy",
                                  )}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="py-3 max-w-[18rem]">
                              <p className="text-sm text-muted-foreground line-clamp-2 italic">
                                &ldquo;{o.reason}&rdquo;
                              </p>
                            </TableCell>
                            <TableCell className="py-3 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                              <div className="flex flex-col">
                                <span>
                                  {format(
                                    parseISO(o.clientCreatedAt ?? o.createdAt),
                                    "MMM d, HH:mm",
                                  )}
                                </span>
                                {o.clientCreatedAt &&
                                  o.clientCreatedAt !== o.createdAt && (
                                    <span className="text-[10px] text-muted-foreground/70">
                                      synced{" "}
                                      {format(parseISO(o.createdAt), "HH:mm")}
                                    </span>
                                  )}
                              </div>
                            </TableCell>
                            <TableCell className="py-3 text-xs text-muted-foreground truncate max-w-[8rem]">
                              {o.creator?.fullName ?? " - "}
                            </TableCell>
                            <TableCell className="py-3">
                              <div className="flex flex-col gap-1">
                                <Badge
                                  variant="outline"
                                  className="border-amber-500/40 text-amber-600 text-[10px] gap-1 w-fit"
                                >
                                  <AlertTriangle className="h-2.5 w-2.5" />
                                  Manual
                                </Badge>
                                {o.offline && (
                                  <Badge
                                    variant="outline"
                                    className="border-muted-foreground/30 text-muted-foreground text-[10px] gap-1 w-fit"
                                    title={
                                      o.syncDelayMs != null
                                        ? `Synced ${Math.round(o.syncDelayMs / 60000)} min after it was created`
                                        : "Synced after being created offline"
                                    }
                                  >
                                    <CloudOff className="h-2.5 w-2.5" />
                                    Offline sync
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                          </motion.tr>
                        ))}
                      </AnimatePresence>
                    </TableBody>
                  </Table>
                </div>

                {/* Pagination */}
                <div className="flex flex-col sm:flex-row items-center justify-between gap-2 px-4 py-3 border-t">
                  <p className="text-xs text-muted-foreground">
                    {pagination
                      ? `Page ${pagination.page} of ${pagination.totalPages} · ${pagination.total} entr${pagination.total === 1 ? "y" : "ies"} total`
                      : " - "}
                  </p>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 min-w-[44px]"
                      disabled={!pagination || pagination.page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      <span className="hidden sm:inline">Prev</span>
                    </Button>
                    <span className="text-xs text-muted-foreground px-2 tabular-nums">
                      {pagination
                        ? `${pagination.page} / ${pagination.totalPages}`
                        : " - "}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 min-w-[44px]"
                      disabled={
                        !pagination || pagination.page >= pagination.totalPages
                      }
                      onClick={() => setPage((p) => p + 1)}
                      aria-label="Next page"
                    >
                      <span className="hidden sm:inline">Next</span>
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </>
            )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Mark this student as present?"
        description={
          selectedStudent
            ? `This will mark ${selectedStudent.fullName} (Student ID ${selectedStudent.studentId}) as present for "${event?.title ?? "this event"}" without a QR scan. The entry will be signed by this device, saved with your name, and can't be undone.`
            : "This will mark the selected student as present without a QR scan. The entry will be signed by this device, saved with your name, and can't be undone."
        }
        confirmLabel="Yes, add them"
        confirmText="ADD"
        destructive={false}
        step2Warning="This will be recorded with your name and device signature."
        onConfirm={submitOverride}
      />
    </div>
  );
}
