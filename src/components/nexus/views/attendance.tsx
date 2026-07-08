"use client";

import { useMemo, useState } from "react";
import { format } from "date-fns";
import {
  ClipboardList,
  Download,
  Users,
  CheckCircle2,
  Clock,
  Activity,
  Radio,
  FileDown,
  Loader2,
  Search,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  Filter,
  X,
  QrCode,
  Hand,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  useEvents,
  useEventAttendance,
  type AttendanceRow,
} from "@/lib/api-client";
import { useAttendanceSocket } from "@/hooks/use-attendance-socket";
import { useDebounce } from "@/hooks/use-debounce";
import { toast } from "@/hooks/use-toast";
import { PROGRAMS } from "@/lib/programs";

const SELECT_NONE = "NONE";
const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Sort keys — keep this list in sync with the dropdown options below.
// ---------------------------------------------------------------------------
type SortKey =
  | "name-asc"
  | "name-desc"
  | "time-desc"
  | "time-asc"
  | "id-asc"
  | "id-desc"
  | "program-asc"
  | "program-desc";

const SORT_LABELS: Record<SortKey, string> = {
  "name-asc": "Name A → Z",
  "name-desc": "Name Z → A",
  "time-desc": "Scan time: newest",
  "time-asc": "Scan time: oldest",
  "id-asc": "Student ID: ascending",
  "id-desc": "Student ID: descending",
  "program-asc": "Program / section A → Z",
  "program-desc": "Program / section Z → A",
};

const FILTER_ALL = "ALL";

export function AttendanceView() {
  const { data: eventsData } = useEvents();
  const events = eventsData?.events ?? [];

  // ---- Event picker state (searchable combobox for large event lists) ----
  // `userSelectedEventId` is null until the user picks an event explicitly;
  // until then we fall back to the first event in the list. Using derived
  // state avoids the "setState in effect" anti-pattern.
  const [userSelectedEventId, setUserSelectedEventId] = useState<number | null>(
    null,
  );
  const eventId: number | null = userSelectedEventId ?? events[0]?.id ?? null;

  // ---- Filter / sort / search state ----
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebounce(searchInput, 300);

  const [programFilter, setProgramFilter] = useState<string>(FILTER_ALL);
  const [sectionFilter, setSectionFilter] = useState<string>(FILTER_ALL);
  const [sourceFilter, setSourceFilter] = useState<string>(FILTER_ALL);
  const [sortBy, setSortBy] = useState<SortKey>("time-desc");
  const [page, setPage] = useState(1);

  function changeEvent(id: number | null) {
    setUserSelectedEventId(id);
    setPage(1);
  }

  // Create the socket first so we can use its connected state to control polling.
  const socket = useAttendanceSocket(eventId);
  // Poll only when the socket is disconnected (fallback). When connected,
  // socket.io pushes realtime updates — no polling needed.
  const presenceQ = useEventAttendance(eventId, {
    socketConnected: socket.connected,
  });

  // ---- Derived: programs/sections present in this event's attendance ----
  const allRows: AttendanceRow[] = presenceQ.data?.attendances ?? [];
  const presentCount = presenceQ.data?.presentCount ?? 0;
  const eligibleCount = presenceQ.data?.eligibleCount ?? 0;
  const turnout =
    eligibleCount > 0
      ? `${Math.round((presentCount / eligibleCount) * 100)}%`
      : "—";

  const programsInEvent = useMemo(() => {
    const set = new Set<string>();
    allRows.forEach((r) => {
      if (r.account.program) set.add(r.account.program);
    });
    return Array.from(set).sort();
  }, [allRows]);

  const sectionsInEvent = useMemo(() => {
    const set = new Set<string>();
    allRows.forEach((r) => {
      if (r.account.section) set.add(r.account.section);
    });
    return Array.from(set).sort();
  }, [allRows]);

  // ---- Apply search → filter → sort ----
  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return allRows.filter((r) => {
      if (programFilter !== FILTER_ALL && r.account.program !== programFilter)
        return false;
      if (sectionFilter !== FILTER_ALL && r.account.section !== sectionFilter)
        return false;
      if (sourceFilter !== FILTER_ALL) {
        const isOverride = r.source === "override";
        if (sourceFilter === "qr" && isOverride) return false;
        if (sourceFilter === "override" && !isOverride) return false;
      }
      if (q) {
        const name = r.account.fullName.toLowerCase();
        const sid =
          r.account.studentId != null ? String(r.account.studentId) : "";
        if (!name.includes(q) && !sid.includes(q)) return false;
      }
      return true;
    });
  }, [allRows, debouncedSearch, programFilter, sectionFilter, sourceFilter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      switch (sortBy) {
        case "name-asc":
          return a.account.fullName.localeCompare(b.account.fullName);
        case "name-desc":
          return b.account.fullName.localeCompare(a.account.fullName);
        case "time-asc":
          return (
            new Date(a.scannedAt).getTime() - new Date(b.scannedAt).getTime()
          );
        case "time-desc":
          return (
            new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime()
          );
        case "id-asc":
          return (a.account.studentId ?? 0) - (b.account.studentId ?? 0);
        case "id-desc":
          return (b.account.studentId ?? 0) - (a.account.studentId ?? 0);
        case "program-asc": {
          const p = (a.account.program ?? "").localeCompare(
            b.account.program ?? "",
          );
          if (p !== 0) return p;
          return (a.account.section ?? "").localeCompare(
            b.account.section ?? "",
          );
        }
        case "program-desc": {
          const p = (b.account.program ?? "").localeCompare(
            a.account.program ?? "",
          );
          if (p !== 0) return p;
          return (b.account.section ?? "").localeCompare(
            a.account.section ?? "",
          );
        }
        default:
          return 0;
      }
    });
    return arr;
  }, [filtered, sortBy]);

  // ---- Pagination ----
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageRows = sorted.slice(pageStart, pageStart + PAGE_SIZE);

  const hasActiveFilters =
    debouncedSearch !== "" ||
    programFilter !== FILTER_ALL ||
    sectionFilter !== FILTER_ALL ||
    sourceFilter !== FILTER_ALL;

  function clearFilters() {
    setSearchInput("");
    setProgramFilter(FILTER_ALL);
    setSectionFilter(FILTER_ALL);
    setSourceFilter(FILTER_ALL);
    setPage(1);
  }

  // Wrap each filter setter so that changing a filter also resets the page
  // to 1 (avoids landing on an empty page after a filter narrows results).
  function changeSearch(v: string) {
    setSearchInput(v);
    setPage(1);
  }
  function changeProgram(v: string) {
    setProgramFilter(v);
    setPage(1);
  }
  function changeSection(v: string) {
    setSectionFilter(v);
    setPage(1);
  }
  function changeSource(v: string) {
    setSourceFilter(v);
    setPage(1);
  }
  function changeSort(v: string) {
    setSortBy(v as SortKey);
    setPage(1);
  }

  function exportCsv() {
    if (sorted.length === 0) {
      toast({
        title: "Nothing to export",
        description: "There are no check-ins matching the current filters.",
        variant: "destructive",
      });
      return;
    }
    const header =
      "Student ID,Full Name,Program,Section,Source,Time In,Time Out\n";
    const body = sorted
      .map((r) => {
        const id = r.account.studentId ?? "";
        const name = escapeCsv(r.account.fullName);
        const program = escapeCsv(r.account.program ?? "");
        const section = escapeCsv(r.account.section ?? "");
        const source = r.source === "override" ? "Manual override" : "QR scan";
        const timeIn = format(new Date(r.scannedAt), "yyyy-MM-dd HH:mm:ss");
        const timeOut = r.timeOutAt
          ? format(new Date(r.timeOutAt), "yyyy-MM-dd HH:mm:ss")
          : "—";
        return `${id},${name},${program},${section},${source},${timeIn},${timeOut}`;
      })
      .join("\n");
    const blob = new Blob([header + body], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `attendance-event-${eventId}-${format(new Date(), "yyyy-MM-dd")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({
      title: "CSV downloaded",
      description: `${sorted.length} rows exported.`,
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2">
                  <ClipboardList className="h-5 w-5 text-primary" />
                  Attendance Roster
                </CardTitle>
                <CardDescription>
                  Live check-in list for the selected event. Filter, sort,
                  search and export.
                </CardDescription>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={exportCsv}
                    disabled={!eventId || sorted.length === 0}
                    className="h-9"
                  >
                    <Download className="h-4 w-4" />
                    <span className="hidden sm:inline">Export CSV</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Download the current filtered list as a CSV file.
                </TooltipContent>
              </Tooltip>
            </div>

            {/* Event picker — searchable combobox, full-width on mobile */}
            <div className="flex flex-col sm:flex-row sm:items-end gap-2">
              <div className="flex-1 min-w-0 space-y-1.5">
                <Label
                  htmlFor="att-event"
                  className="text-xs text-muted-foreground"
                >
                  Event
                </Label>
                <EventCombobox
                  events={events}
                  value={eventId}
                  onChange={changeEvent}
                  placeholder="Select an event…"
                />
              </div>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {!eventId && (
            <p className="text-center text-sm text-muted-foreground py-10">
              Select an event to see who has checked in.
            </p>
          )}

          {eventId && (
            <>
              {/* Event status banner */}
              {(() => {
                const selectedEvent = events.find((e) => e.id === eventId);
                const status = selectedEvent?.timeStatus;
                if (!status) return null;
                const isLive = status === "live";
                const isUpcoming = status === "upcoming";
                return (
                  <div
                    className={`rounded-lg p-3 flex items-center gap-2 text-sm ${
                      isLive
                        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                        : isUpcoming
                          ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isLive && (
                      <Radio className="h-4 w-4 animate-pulse shrink-0" />
                    )}
                    {(isUpcoming || status === "ended") && (
                      <Clock className="h-4 w-4 shrink-0" />
                    )}
                    <span className="font-medium">
                      {isLive
                        ? "This event is live now — students can scan to check in."
                        : isUpcoming
                          ? "This event hasn't started yet — check-in is not open."
                          : "This event has ended — check-in is closed."}
                    </span>
                  </div>
                );
              })()}

              {/* Stat grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat
                  icon={<CheckCircle2 className="h-4 w-4" />}
                  label="Present"
                  value={presentCount}
                  tone="primary"
                />
                <Stat
                  icon={<Users className="h-4 w-4" />}
                  label="Eligible"
                  value={eligibleCount}
                />
                <Stat
                  icon={<Activity className="h-4 w-4" />}
                  label="Turnout"
                  value={turnout}
                />
                <Stat
                  icon={
                    socket.connected ? (
                      <Radio className="h-4 w-4" />
                    ) : (
                      <Clock className="h-4 w-4" />
                    )
                  }
                  label="Connection"
                  value={socket.connected ? "Instant" : "Polling"}
                  tone={socket.connected ? "primary" : undefined}
                />
              </div>

              {/* Filter / sort / search toolbar */}
              <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    Filter & sort
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
                {/* Unified grid: 1 col mobile, 2 cols sm, 3 cols lg, 5 cols xl */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-2">
                  {/* Search */}
                  <div className="relative sm:col-span-2 lg:col-span-1">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                    <Input
                      placeholder="Search name or ID…"
                      value={searchInput}
                      onChange={(e) => changeSearch(e.target.value)}
                      className="pl-8 h-9"
                      aria-label="Search by name or student ID"
                    />
                  </div>

                  {/* Source filter */}
                  <Select value={sourceFilter} onValueChange={changeSource}>
                    <SelectTrigger
                      className="h-9 w-full"
                      aria-label="Filter by source"
                    >
                      <SelectValue placeholder="All sources" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={FILTER_ALL}>All sources</SelectItem>
                      <SelectItem value="qr">QR scan only</SelectItem>
                      <SelectItem value="override">
                        Manual override only
                      </SelectItem>
                    </SelectContent>
                  </Select>

                  {/* Program filter */}
                  <Select value={programFilter} onValueChange={changeProgram}>
                    <SelectTrigger
                      className="h-9 w-full"
                      aria-label="Filter by program"
                    >
                      <SelectValue placeholder="All programs" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={FILTER_ALL}>All programs</SelectItem>
                      {programsInEvent.map((p) => (
                        <SelectItem key={p} value={p}>
                          {PROGRAMS.find((pr) => pr.code === p)?.label ?? p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {/* Section filter */}
                  <Select value={sectionFilter} onValueChange={changeSection}>
                    <SelectTrigger
                      className="h-9 w-full"
                      aria-label="Filter by section"
                    >
                      <SelectValue placeholder="All sections" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={FILTER_ALL}>All sections</SelectItem>
                      {sectionsInEvent.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {/* Sort */}
                  <Select value={sortBy} onValueChange={changeSort}>
                    <SelectTrigger className="h-9 w-full" aria-label="Sort by">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                        <SelectItem key={k} value={k}>
                          {SORT_LABELS[k]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {hasActiveFilters && (
                  <p className="text-xs text-muted-foreground">
                    Showing {sorted.length} of {allRows.length} check-ins
                    {sorted.length !== allRows.length && " (filtered)"}
                  </p>
                )}
              </div>

              {/* Loading / empty states */}
              {presenceQ.isLoading && (
                <div className="text-center text-sm text-muted-foreground py-10">
                  <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                  Loading attendance…
                </div>
              )}

              {!presenceQ.isLoading && sorted.length === 0 && (
                <div className="text-center text-sm text-muted-foreground py-10">
                  <FileDown className="h-6 w-6 mx-auto mb-2 opacity-50" />
                  {allRows.length === 0
                    ? "No check-ins recorded yet. New check-ins will appear here automatically."
                    : "No check-ins match your filters."}
                </div>
              )}

              {/* Data display — table on md+, cards on mobile */}
              {!presenceQ.isLoading && sorted.length > 0 && (
                <>
                  {/* Desktop / tablet table */}
                  <div className="hidden md:block rounded-md border max-h-[32rem] overflow-y-auto ng-scroll">
                    <Table>
                      <TableHeader className="sticky top-0 bg-card z-10">
                        <TableRow>
                          <TableHead className="w-12">#</TableHead>
                          <TableHead>Student ID</TableHead>
                          <TableHead>Full Name</TableHead>
                          <TableHead>Program</TableHead>
                          <TableHead>Section</TableHead>
                          <TableHead>Source</TableHead>
                          <TableHead>Time In</TableHead>
                          <TableHead>Time Out</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        <AnimatePresence initial={false}>
                          {pageRows.map((a, i) => {
                            const isNew = socket.latest?.id === a.id;
                            const isOverride = a.source === "override";
                            return (
                              <motion.tr
                                key={a.id}
                                layout
                                initial={
                                  isNew
                                    ? {
                                        opacity: 0,
                                        backgroundColor:
                                          "rgba(245, 158, 11, 0.18)",
                                      }
                                    : false
                                }
                                animate={{
                                  opacity: 1,
                                  backgroundColor: "rgba(245, 158, 11, 0)",
                                }}
                                transition={{ duration: 1.2 }}
                                className="hover:bg-muted/40"
                              >
                                <TableCell className="text-muted-foreground tabular-nums">
                                  {pageStart + i + 1}
                                </TableCell>
                                <TableCell className="font-mono text-xs tabular-nums">
                                  {a.account.studentId ?? "—"}
                                </TableCell>
                                <TableCell className="font-medium">
                                  {a.account.fullName}
                                </TableCell>
                                <TableCell>
                                  {a.account.program ? (
                                    <Badge
                                      variant="outline"
                                      className="text-[10px]"
                                    >
                                      {a.account.program}
                                    </Badge>
                                  ) : (
                                    <span className="text-muted-foreground">
                                      —
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  {a.account.section ? (
                                    <Badge
                                      variant="outline"
                                      className="text-[10px]"
                                    >
                                      {a.account.section}
                                    </Badge>
                                  ) : (
                                    <span className="text-muted-foreground">
                                      —
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  {isOverride ? (
                                    <Badge
                                      variant="outline"
                                      className="border-amber-500/40 text-amber-600 text-[10px] gap-1"
                                    >
                                      <Hand className="h-2.5 w-2.5" />
                                      Manual
                                    </Badge>
                                  ) : (
                                    <Badge
                                      variant="outline"
                                      className="border-emerald-500/40 text-emerald-600 text-[10px] gap-1"
                                    >
                                      <QrCode className="h-2.5 w-2.5" />
                                      QR
                                    </Badge>
                                  )}
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                                  {format(new Date(a.scannedAt), "HH:mm:ss")}
                                </TableCell>
                                <TableCell className="text-xs tabular-nums whitespace-nowrap">
                                  {a.timeOutAt ? (
                                    <span className="text-muted-foreground">
                                      {format(
                                        new Date(a.timeOutAt),
                                        "HH:mm:ss",
                                      )}
                                    </span>
                                  ) : (
                                    <Badge
                                      variant="outline"
                                      className="border-amber-500/40 text-amber-600 text-[10px]"
                                    >
                                      Still in
                                    </Badge>
                                  )}
                                </TableCell>
                              </motion.tr>
                            );
                          })}
                        </AnimatePresence>
                      </TableBody>
                    </Table>
                  </div>

                  {/* Mobile card list */}
                  <div className="md:hidden space-y-2">
                    <AnimatePresence initial={false}>
                      {pageRows.map((a, i) => {
                        const isNew = socket.latest?.id === a.id;
                        const isOverride = a.source === "override";
                        return (
                          <motion.div
                            key={a.id}
                            layout
                            initial={
                              isNew
                                ? {
                                    opacity: 0,
                                    backgroundColor: "rgba(245, 158, 11, 0.18)",
                                  }
                                : false
                            }
                            animate={{
                              opacity: 1,
                              backgroundColor: "rgba(245, 158, 11, 0)",
                            }}
                            transition={{ duration: 1.2 }}
                            className="rounded-lg border p-3 space-y-2"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">
                                  {a.account.fullName}
                                </p>
                                <p className="text-xs text-muted-foreground font-mono">
                                  ID #{a.account.studentId ?? "—"}
                                </p>
                              </div>
                              <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 mt-0.5">
                                #{pageStart + i + 1}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {a.account.program && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px]"
                                >
                                  {a.account.program}
                                </Badge>
                              )}
                              {a.account.section && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px]"
                                >
                                  {a.account.section}
                                </Badge>
                              )}
                              {isOverride ? (
                                <Badge
                                  variant="outline"
                                  className="border-amber-500/40 text-amber-600 text-[10px]"
                                >
                                  Manual
                                </Badge>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="border-emerald-500/40 text-emerald-600 text-[10px]"
                                >
                                  QR
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">
                                In:{" "}
                                <span className="tabular-nums">
                                  {format(new Date(a.scannedAt), "HH:mm:ss")}
                                </span>
                              </span>
                              <span className="text-muted-foreground">
                                {a.timeOutAt ? (
                                  <>
                                    Out:{" "}
                                    <span className="tabular-nums">
                                      {format(
                                        new Date(a.timeOutAt),
                                        "HH:mm:ss",
                                      )}
                                    </span>
                                  </>
                                ) : (
                                  <Badge
                                    variant="outline"
                                    className="border-amber-500/40 text-amber-600 text-[10px]"
                                  >
                                    Still in
                                  </Badge>
                                )}
                              </span>
                            </div>
                          </motion.div>
                        );
                      })}
                    </AnimatePresence>
                  </div>

                  {/* Pagination */}
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-1">
                    <p className="text-xs text-muted-foreground">
                      Showing {pageStart + 1}–
                      {Math.min(pageStart + PAGE_SIZE, sorted.length)} of{" "}
                      {sorted.length}
                      {sorted.length !== allRows.length &&
                        ` (filtered from ${allRows.length})`}
                    </p>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-9 min-w-[44px]"
                        disabled={currentPage <= 1}
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        aria-label="Previous page"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <span className="text-xs text-muted-foreground px-2 tabular-nums">
                        {currentPage} / {totalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-9 min-w-[44px]"
                        disabled={currentPage >= totalPages}
                        onClick={() =>
                          setPage((p) => Math.min(totalPages, p + 1))
                        }
                        aria-label="Next page"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </>
              )}

              {/* Footer hint */}
              <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1">
                <FileDown className="h-3.5 w-3.5" />
                <span>
                  {presentCount} present of {eligibleCount} eligible student
                  {eligibleCount === 1 ? "" : "s"}.
                </span>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone?: "primary";
}) {
  return (
    <div
      className={`rounded-lg p-3 ${
        tone === "primary" ? "bg-primary/10" : "bg-muted/50"
      }`}
    >
      <div
        className={`flex items-center gap-1.5 text-xs font-medium ${
          tone === "primary" ? "text-primary" : "text-muted-foreground"
        }`}
      >
        {icon}
        {label}
      </div>
      <div
        className={`text-2xl font-bold mt-1 ${
          tone === "primary" ? "text-primary" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function escapeCsv(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
