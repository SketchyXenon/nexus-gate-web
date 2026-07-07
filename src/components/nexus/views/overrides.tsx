"use client";

import { useMemo, useState } from "react";
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
  useCreateOverride,
  useOverrides,
  type OverrideRow,
} from "@/lib/api-client";
import { useDebounce } from "@/hooks/use-debounce";
import { toast } from "@/hooks/use-toast";

const SELECT_NONE = "NONE";
const DEFAULT_REASON = "Couldn't scan — missing or broken phone";
const PAGE_SIZE = 25;

export function OverridesView() {
  // ============================================================
  //  Form state (Create Override)
  // ============================================================
  const { data: eventsData } = useEvents();
  const events = eventsData?.events ?? [];

  const [formEventId, setFormEventId] = useState<number | null>(null);
  // `formEventId` is null until events load — derived default uses the first
  // event. We don't need an effect for the default.
  const effectiveFormEventId: number | null =
    formEventId ?? events[0]?.id ?? null;
  const event = events.find((e) => e.id === effectiveFormEventId);

  const [selectedStudentId, setSelectedStudentId] =
    useState<string>(SELECT_NONE);
  const [reason, setReason] = useState(DEFAULT_REASON);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // List state
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebounce(searchInput, 300);
  const [listEventId, setListEventId] = useState<number | null>(null);
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [page, setPage] = useState(1);

  // Whitelist (filtered by event's program/section) + existing attendance
  // for the form's selected event — used to compute the "missing students"
  // list shown in the student picker.
  //
  // Event targeting logic:
  //   - Both program + section set  → fetch students matching BOTH
  //   - Program set, section null   → fetch all students in that program
  //   - Both null (dept-wide)       → fetch ALL students (no filter)
  //
  // pageSize=500 (was 200, which exceeded the old pagination cap of 100
  // and caused a 400 Bad Request). The whitelist schema now allows up to 500.
  const isDeptWide = !event?.targetProgram && !event?.targetSection;
  const whitelistQ = useWhitelist({
    program: event?.targetProgram || undefined,
    section: event?.targetSection || undefined,
    pageSize: 500,
    // Only fetch once an event is selected (prevents fetching ALL students
    // before the organizer picks an event).
    enabled: effectiveFormEventId != null,
  });
  const whitelist = whitelistQ.data?.students ?? [];
  // Disable 4s polling on the override page — we only need a snapshot of
  // who's present, not live updates. Polling caused constant 403 errors
  // for organizers viewing events they didn't own.
  const presenceQ = useEventAttendance(effectiveFormEventId, { poll: false });
  const create = useCreateOverride();

  const presentIds = useMemo(
    () =>
      new Set(
        (presenceQ.data?.attendances ?? [])
          .map((a) => a.account.studentId)
          .filter((v): v is number => v != null),
      ),
    [presenceQ.data],
  );
  const missingStudents = useMemo(
    () => whitelist.filter((s) => !presentIds.has(s.studentId)),
    [whitelist, presentIds],
  );
  // True only when the whitelist has LOADED and has students, but all are present.
  // NOT true when the whitelist is empty/loading (which would be a false positive).
  const allPresent =
    !whitelistQ.isLoading &&
    !presenceQ.isLoading &&
    whitelist.length > 0 &&
    missingStudents.length === 0;

  const selectedStudent = missingStudents.find(
    (s) => String(s.studentId) === selectedStudentId,
  );

  // ============================================================
  //  List state (Recent Manual Entries)
  // ============================================================
  // (searchInput/debouncedSearch/listEventId/fromDate/toDate/page declared above)

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

  function submitOverride() {
    if (!effectiveFormEventId || selectedStudentId === SELECT_NONE) return;
    const studentId = Number(selectedStudentId);
    create.mutate(
      { eventId: effectiveFormEventId, studentId, reason: reason.trim() },
      {
        onSuccess: () => {
          toast({
            title: "Student marked as present",
            description: "The manual entry has been saved with your name.",
          });
          setSelectedStudentId(SELECT_NONE);
          setReason(DEFAULT_REASON);
        },
        onError: (e) =>
          toast({
            title: "Couldn't save the manual entry",
            description: e.message,
            variant: "destructive",
          }),
      },
    );
  }

  // ============================================================
  //  Render
  // ============================================================
  return (
    <div className="grid gap-6 lg:grid-cols-3 min-w-0">
      {/* ============== CREATE OVERRIDE FORM ============== */}
      <Card className="h-fit lg:col-span-1 min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-primary" />
            Add Student Manually
          </CardTitle>
          <CardDescription>
            Use this only when a student couldn&apos;t scan their QR code.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md bg-amber-500/10 border border-amber-500/30 p-3 text-xs text-amber-700 dark:text-amber-400 flex gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <p>
              This skips the QR scan and marks the student as present right
              away. Each entry is saved with your name and the time, so please
              use it only when the student really couldn&apos;t scan.
            </p>
          </div>

          {/* Event picker — searchable combobox (handles many events) */}
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
            {event && (
              <p className="text-[11px] text-muted-foreground">
                {isDeptWide
                  ? "Department-wide event — showing all students."
                  : `Showing students in ${event.targetProgram ?? "all programs"}${event.targetSection ? `, section ${event.targetSection}` : ""}.`}
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
                <SelectValue placeholder="Pick a student who hasn't checked in…" />
              </SelectTrigger>
              <SelectContent>
                {whitelistQ.isLoading && (
                  <SelectItem value={SELECT_NONE} disabled>
                    Loading students…
                  </SelectItem>
                )}
                {!whitelistQ.isLoading &&
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
              !whitelistQ.isLoading &&
              !allPresent &&
              whitelist.length === 0 && (
                <p className="text-xs text-amber-600 flex items-center gap-1.5">
                  <Info className="h-3.5 w-3.5" />
                  No students found for this event's program/section. Import
                  students first.
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
                  create.isPending
                }
              >
                {create.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Mark student as present
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              You&apos;ll be asked to confirm before the entry is saved.
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

            {/* Date range — two inputs side by side, spans 2 cols on desktop */}
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
                              {format(parseISO(o.createdAt), "MMM d, HH:mm")}
                            </TableCell>
                            <TableCell className="py-3 text-xs text-muted-foreground truncate max-w-[8rem]">
                              {o.admin?.fullName ?? "—"}
                            </TableCell>
                            <TableCell className="py-3">
                              <Badge
                                variant="outline"
                                className="border-amber-500/40 text-amber-600 text-[10px] gap-1"
                              >
                                <AlertTriangle className="h-2.5 w-2.5" />
                                Manual
                              </Badge>
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
                      : "—"}
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
                        : "—"}
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
            ? `This will mark ${selectedStudent.fullName} (Student ID ${selectedStudent.studentId}) as present for "${event?.title ?? "this event"}" without a QR scan. The entry will be saved with your name and can't be undone.`
            : "This will mark the selected student as present without a QR scan. The entry will be saved with your name and can't be undone."
        }
        confirmLabel="Yes, add them"
        confirmText="ADD"
        destructive={false}
        step2Warning="This will be recorded with your name."
        onConfirm={submitOverride}
      />
    </div>
  );
}
