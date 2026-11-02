"use client";

// ====================================================================
// Schedules view - recurring weekly class timetable with day/night
// shift support. Institutions here run DAY and NIGHT class shifts for
// the same program/section, so every slot is tagged with its shift.
//
// Role-aware:
//   - USER: read-only "My Schedule" scoped server-side to their own
//     program/section, with a Day/Night toggle (defaults to their own
//     shift when classified) and a "Today" highlight.
//   - ORGANIZER: manage their program's timetable (create/edit/delete).
//   - ADMIN: manage everything, including department-wide rows.
//
// UI rules honored: text-only buttons (no decorative icons), mobile-first
// card layout (no table overflow on small screens), 44px touch targets,
// amber/emerald palette, labelled inputs for screen readers.
// ====================================================================

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  CalendarClock,
  MapPin,
  UserRound,
  Sun,
  MoonStar,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/nexus/confirm-dialog";
import {
  useMe,
  useSchedules,
  useCreateSchedule,
  useUpdateSchedule,
  useDeleteSchedule,
  type ScheduleItem,
  type ClassShift,
} from "@/lib/api-client";
import { PROGRAMS, getProgramLabel } from "@/lib/programs";
import { toast } from "@/hooks/use-toast";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// "HH:MM" 24h → "H:MM AM/PM" for readability (times are validated HH:MM).
function formatTime(t: string): string {
  const [hStr, m] = t.split(":");
  const h = Number(hStr);
  if (Number.isNaN(h)) return t;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${period}`;
}

const shiftBadgeClass = (shift: string): string =>
  shift === "NIGHT"
    ? "border-slate-500/40 text-slate-600 dark:text-slate-300"
    : "border-amber-500/40 text-amber-600";

const SECTION_PATTERN = /^\d+-[A-Za-z]+$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

interface ScheduleFormState {
  program: string; // "" = none/department-wide (admins only)
  section: string; // "" = program-wide
  shift: ClassShift;
  dayOfWeek: string;
  subject: string;
  instructor: string;
  room: string;
  startTime: string;
  endTime: string;
  isActive: string; // "true" | "false"
}

const EMPTY_FORM: ScheduleFormState = {
  program: "",
  section: "",
  shift: "DAY",
  dayOfWeek: "1",
  subject: "",
  instructor: "",
  room: "",
  startTime: "",
  endTime: "",
  isActive: "true",
};

export function SchedulesView() {
  const { data: me } = useMe();
  const role = me?.role ?? "USER";
  const canManage = role === "ADMIN" || role === "ORGANIZER";

  // Students default to their own classified shift (derived, no effect:
  // userShiftOverride stays null until they click a toggle). Unclassified
  // students and staff start with ALL.
  const [userShiftOverride, setUserShiftOverride] = useState<
    "DAY" | "NIGHT" | "ALL" | null
  >(null);
  const ownShift =
    role === "USER" && (me?.shift === "DAY" || me?.shift === "NIGHT")
      ? me.shift
      : null;
  const shiftFilter = userShiftOverride ?? ownShift ?? "ALL";
  const [dayFilter, setDayFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounced search (300ms, matches the other toolbars).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useSchedules({
    shift: shiftFilter,
    day: dayFilter !== "all" ? Number(dayFilter) : undefined,
    q: canManage ? debouncedSearch || undefined : undefined,
    pageSize: 200,
  });
  const schedules = data?.schedules ?? [];
  const today = new Date().getDay();

  const createSchedule = useCreateSchedule();
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();

  // ---- Dialog state ----
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleItem | null>(null);
  const [form, setForm] = useState<ScheduleFormState>(EMPTY_FORM);
  const [deleting, setDeleting] = useState<ScheduleItem | null>(null);
  const [saving, setSaving] = useState(false);

  const openCreate = () => {
    setEditing(null);
    setForm({
      ...EMPTY_FORM,
      // Organizers are server-locked to their own program - preselect it.
      program: role === "ORGANIZER" ? (me?.program ?? "") : "",
    });
    setDialogOpen(true);
  };

  const openEdit = (s: ScheduleItem) => {
    setEditing(s);
    setForm({
      program: s.program ?? "",
      section: s.section ?? "",
      shift: s.shift,
      dayOfWeek: String(s.dayOfWeek),
      subject: s.subject,
      instructor: s.instructor ?? "",
      room: s.room ?? "",
      startTime: s.startTime,
      endTime: s.endTime,
      isActive: s.isActive ? "true" : "false",
    });
    setDialogOpen(true);
  };

  const validateForm = (): string | null => {
    if (!form.subject.trim()) return "Enter a subject name.";
    if (!TIME_PATTERN.test(form.startTime)) return "Start time must be HH:MM (24h), e.g. 08:00.";
    if (!TIME_PATTERN.test(form.endTime)) return "End time must be HH:MM (24h), e.g. 19:30.";
    if (form.endTime <= form.startTime) return "End time must be after the start time.";
    if (form.program && !PROGRAMS.some((p) => p.code === form.program)) {
      return "Select a valid program.";
    }
    if (form.section && !SECTION_PATTERN.test(form.section.trim())) {
      return "Section must look like '2-A' (year-letter).";
    }
    if (!canManage && role === "ORGANIZER" && !me?.program && form.program) {
      return "Your account has no program assigned. Ask an administrator.";
    }
    return null;
  };

  const handleSave = async () => {
    const problem = validateForm();
    if (problem) {
      toast({ title: "Check the form", description: problem, variant: "destructive" });
      return;
    }
    setSaving(true);
    const payload = {
      program: form.program || null,
      section: form.section.trim() || null,
      shift: form.shift,
      dayOfWeek: Number(form.dayOfWeek),
      subject: form.subject.trim(),
      instructor: form.instructor.trim() || null,
      room: form.room.trim() || null,
      startTime: form.startTime,
      endTime: form.endTime,
      isActive: form.isActive === "true",
    };
    try {
      if (editing) {
        await updateSchedule.mutateAsync({ id: editing.id, data: payload });
        toast({ title: "Schedule updated", description: `${payload.subject} on ${DAY_NAMES[payload.dayOfWeek]}.` });
      } else {
        await createSchedule.mutateAsync(payload);
        toast({ title: "Schedule added", description: `${payload.subject} on ${DAY_NAMES[payload.dayOfWeek]}.` });
      }
      setDialogOpen(false);
    } catch (e) {
      toast({
        title: editing ? "Update failed" : "Could not add schedule",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await deleteSchedule.mutateAsync(deleting.id);
      toast({ title: "Schedule removed", description: `${deleting.subject} was deleted.` });
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setDeleting(null);
    }
  };

  const clearFilters = () => {
    setUserShiftOverride("ALL");
    setDayFilter("all");
    setSearch("");
  };

  // Group by shift, then by day - the natural reading order for a
  // day/night timetable.
  const grouped = useMemo(() => {
    const byShift = new Map<ClassShift, ScheduleItem[]>();
    for (const s of schedules) {
      const list = byShift.get(s.shift) ?? [];
      list.push(s);
      byShift.set(s.shift, list);
    }
    for (const list of byShift.values()) {
      list.sort(
        (a, b) =>
          a.dayOfWeek - b.dayOfWeek ||
          a.startTime.localeCompare(b.startTime) ||
          (a.section ?? "").localeCompare(b.section ?? ""),
      );
    }
    return byShift;
  }, [schedules]);

  const hasFilters = shiftFilter !== "ALL" || dayFilter !== "all" || search.trim() !== "";
  const shiftTabs: Array<{ value: "DAY" | "NIGHT" | "ALL"; label: string }> = [
    { value: "DAY", label: "Day" },
    { value: "NIGHT", label: "Night" },
    ...(canManage ? [{ value: "ALL" as const, label: "All" }] : []),
  ];

  const renderRowMeta = (s: ScheduleItem) => (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <Badge variant="outline" className={shiftBadgeClass(s.shift)}>
        {s.shift === "NIGHT" ? "Night" : "Day"}
      </Badge>
      <span>{DAY_NAMES[s.dayOfWeek]}</span>
      <span aria-hidden="true">&middot;</span>
      <span>
        {formatTime(s.startTime)} &ndash; {formatTime(s.endTime)}
      </span>
      {s.section ? (
        <>
          <span aria-hidden="true">&middot;</span>
          <span>
            {s.program ?? "All"} {s.section}
          </span>
        </>
      ) : s.program ? (
        <>
          <span aria-hidden="true">&middot;</span>
          <span>{getProgramLabel(s.program) ?? s.program} (all sections)</span>
        </>
      ) : (
        <>
          <span aria-hidden="true">&middot;</span>
          <span>Department-wide</span>
        </>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {canManage ? "Class Schedules" : "My Schedule"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {canManage
              ? "Weekly timetable for day and night class shifts."
              : "Your recurring weekly classes for the day and night shifts."}
          </p>
        </div>
        {canManage && (
          <Button onClick={openCreate} className="shrink-0">
            Add Schedule
          </Button>
        )}
      </div>

      {/* Filter toolbar (staff) / shift toggle (students) */}
      <Card>
        <CardContent className="p-3 sm:p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Label htmlFor="schedule-shift" className="sr-only">
                Class shift filter
              </Label>
              <div
                role="group"
                aria-label="Class shift filter"
                className="flex h-9 w-full items-center rounded-md border bg-muted/40 p-0.5"
              >
                {shiftTabs.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    aria-pressed={shiftFilter === t.value}
                    onClick={() => setUserShiftOverride(t.value)}
                    className={`flex h-8 flex-1 items-center justify-center rounded-sm px-2 text-sm font-medium transition-colors ${
                      shiftFilter === t.value
                        ? "bg-background shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label htmlFor="schedule-day" className="sr-only">
                Day of week
              </Label>
              <Select value={dayFilter} onValueChange={setDayFilter}>
                <SelectTrigger id="schedule-day" className="h-9 w-full" aria-label="Filter by day of week">
                  <SelectValue placeholder="All days" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All days</SelectItem>
                  {DAY_NAMES.map((name, idx) => (
                    <SelectItem key={name} value={String(idx)}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {canManage && (
              <div>
                <Label htmlFor="schedule-search" className="sr-only">
                  Search schedules
                </Label>
                <Input
                  id="schedule-search"
                  type="search"
                  placeholder="Search subject, instructor, room..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-9"
                  autoComplete="off"
                />
              </div>
            )}
            <div className="flex items-center sm:justify-end">
              {hasFilters && (
                <Button variant="outline" size="sm" className="h-9" onClick={clearFilters}>
                  Clear
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-3" aria-live="polite" aria-busy="true">
          <span className="sr-only">Loading schedules</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : schedules.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <CalendarClock className="h-10 w-10 text-muted-foreground/50" aria-hidden="true" />
            <p className="font-medium">No schedules found</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {hasFilters
                ? "Try a different shift or day filter."
                : canManage
                  ? "Add the first class slot to build the weekly timetable."
                  : "No recurring classes have been published for your section yet."}
            </p>
            {canManage && !hasFilters && (
              <Button onClick={openCreate} className="mt-2">
                Add Schedule
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {[...grouped.entries()].map(([shift, rows]) => (
            <section key={shift} aria-labelledby={`shift-${shift}-heading`}>
              <div className="mb-2 flex items-center gap-2">
                {shift === "NIGHT" ? (
                  <MoonStar className="h-4 w-4 text-slate-500" aria-hidden="true" />
                ) : (
                  <Sun className="h-4 w-4 text-amber-500" aria-hidden="true" />
                )}
                <h2
                  id={`shift-${shift}-heading`}
                  className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {shift === "NIGHT" ? "Night Shift" : "Day Shift"}
                  <span className="ml-2 font-normal normal-case">
                    {"\u00b7"} {rows.length} {rows.length === 1 ? "class" : "classes"}
                  </span>
                </h2>
              </div>

              {/* Desktop table */}
              <Card className="hidden md:block">
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <caption className="sr-only">
                        {shift === "NIGHT" ? "Night" : "Day"} shift weekly class schedule
                      </caption>
                      <thead>
                        <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <th scope="col" className="px-4 py-2.5 font-medium">Day</th>
                          <th scope="col" className="px-4 py-2.5 font-medium">Time</th>
                          <th scope="col" className="px-4 py-2.5 font-medium">Subject</th>
                          <th scope="col" className="px-4 py-2.5 font-medium">Section</th>
                          <th scope="col" className="px-4 py-2.5 font-medium">Instructor</th>
                          <th scope="col" className="px-4 py-2.5 font-medium">Room</th>
                          {canManage && (
                            <th scope="col" className="px-4 py-2.5 text-right font-medium">
                              <span className="sr-only">Actions</span>
                              <span aria-hidden="true">Actions</span>
                            </th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((s) => (
                          <tr
                            key={s.id}
                            className={`border-b last:border-0 ${
                              s.dayOfWeek === today ? "bg-amber-500/5" : ""
                            }`}
                          >
                            <td className="px-4 py-3 whitespace-nowrap">
                              {DAY_NAMES[s.dayOfWeek]}
                              {s.dayOfWeek === today && (
                                <Badge variant="outline" className="ml-2 border-amber-500/40 text-amber-600">
                                  Today
                                </Badge>
                              )}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              {formatTime(s.startTime)} &ndash; {formatTime(s.endTime)}
                            </td>
                            <td className="px-4 py-3 font-medium">{s.subject}</td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              {s.section
                                ? `${s.program ?? "All"} ${s.section}`
                                : s.program
                                  ? `${getProgramLabel(s.program) ?? s.program}`
                                  : "Department-wide"}
                            </td>
                            <td className="px-4 py-3">{s.instructor || <span className="text-muted-foreground">&mdash;</span>}</td>
                            <td className="px-4 py-3">{s.room || <span className="text-muted-foreground">&mdash;</span>}</td>
                            {canManage && (
                              <td className="px-4 py-3">
                                <div className="flex justify-end gap-2">
                                  <Button variant="outline" size="sm" className="h-9" onClick={() => openEdit(s)}>
                                    Edit
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-9 text-destructive hover:text-destructive"
                                    onClick={() => setDeleting(s)}
                                  >
                                    Delete
                                  </Button>
                                </div>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              {/* Mobile cards */}
              <div className="space-y-2 md:hidden">
                {rows.map((s) => (
                  <motion.div
                    key={s.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    <Card className={s.dayOfWeek === today ? "border-amber-500/40" : undefined}>
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-medium leading-snug">{s.subject}</p>
                            {renderRowMeta(s)}
                          </div>
                          {s.dayOfWeek === today && (
                            <Badge variant="outline" className="shrink-0 border-amber-500/40 text-amber-600">
                              Today
                            </Badge>
                          )}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          {s.instructor && (
                            <span className="inline-flex items-center gap-1">
                              <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
                              {s.instructor}
                            </span>
                          )}
                          {s.room && (
                            <span className="inline-flex items-center gap-1">
                              <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                              {s.room}
                            </span>
                          )}
                        </div>
                        {canManage && (
                          <div className="mt-3 flex gap-2">
                            <Button variant="outline" size="sm" className="h-9 flex-1" onClick={() => openEdit(s)}>
                              Edit
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-9 flex-1 text-destructive hover:text-destructive"
                              onClick={() => setDeleting(s)}
                            >
                              Delete
                            </Button>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Create / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Schedule" : "Add Schedule"}</DialogTitle>
            <DialogDescription>
              One weekly class slot. Tag it as a Day or Night class so the right
              student population sees it.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid grid-cols-1 gap-4 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              handleSave();
            }}
          >
            <div className="sm:col-span-2">
              <Label htmlFor="schedule-subject">Subject</Label>
              <Textarea
                id="schedule-subject"
                value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
                placeholder="e.g. Web Systems and Technologies"
                rows={1}
                className="mt-1 resize-none"
                required
              />
            </div>
            <div>
              <Label htmlFor="schedule-shift-select">Class shift</Label>
              <Select
                value={form.shift}
                onValueChange={(v) => setForm({ ...form, shift: v as ClassShift })}
              >
                <SelectTrigger id="schedule-shift-select" className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DAY">Day (06:00-17:59)</SelectItem>
                  <SelectItem value="NIGHT">Night (18:00-23:59)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="schedule-day-select">Day of week</Label>
              <Select
                value={form.dayOfWeek}
                onValueChange={(v) => setForm({ ...form, dayOfWeek: v })}
              >
                <SelectTrigger id="schedule-day-select" className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAY_NAMES.map((name, idx) => (
                    <SelectItem key={name} value={String(idx)}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="schedule-start">Start time (24h)</Label>
              <Input
                id="schedule-start"
                type="time"
                value={form.startTime}
                onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                className="mt-1"
                required
              />
            </div>
            <div>
              <Label htmlFor="schedule-end">End time (24h)</Label>
              <Input
                id="schedule-end"
                type="time"
                value={form.endTime}
                onChange={(e) => setForm({ ...form, endTime: e.target.value })}
                className="mt-1"
                required
              />
            </div>
            {role === "ADMIN" ? (
              <div>
                <Label htmlFor="schedule-program">Program</Label>
                <Select
                  value={form.program || "none"}
                  onValueChange={(v) => setForm({ ...form, program: v === "none" ? "" : v })}
                >
                  <SelectTrigger id="schedule-program" className="mt-1 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Department-wide</SelectItem>
                    {PROGRAMS.map((p) => (
                      <SelectItem key={p.code} value={p.code}>
                        {p.code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div>
                <Label htmlFor="schedule-program-fixed">Program</Label>
                <Input
                  id="schedule-program-fixed"
                  value={me?.program ?? ""}
                  disabled
                  aria-describedby="schedule-program-hint"
                  className="mt-1"
                />
                <p id="schedule-program-hint" className="mt-1 text-xs text-muted-foreground">
                  Locked to your program.
                </p>
              </div>
            )}
            <div>
              <Label htmlFor="schedule-section">Section (optional)</Label>
              <Input
                id="schedule-section"
                value={form.section}
                onChange={(e) => setForm({ ...form, section: e.target.value })}
                placeholder="e.g. 2-A"
                className="mt-1"
                aria-describedby="schedule-section-hint"
              />
              <p id="schedule-section-hint" className="mt-1 text-xs text-muted-foreground">
                Empty = all sections in the program.
              </p>
            </div>
            <div>
              <Label htmlFor="schedule-instructor">Instructor (optional)</Label>
              <Input
                id="schedule-instructor"
                value={form.instructor}
                onChange={(e) => setForm({ ...form, instructor: e.target.value })}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="schedule-room">Room (optional)</Label>
              <Input
                id="schedule-room"
                value={form.room}
                onChange={(e) => setForm({ ...form, room: e.target.value })}
                className="mt-1"
              />
            </div>
            {editing && (
              <div>
                <Label htmlFor="schedule-active">Status</Label>
                <Select
                  value={form.isActive}
                  onValueChange={(v) => setForm({ ...form, isActive: v })}
                >
                  <SelectTrigger id="schedule-active" className="mt-1 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Active</SelectItem>
                    <SelectItem value="false">Archived</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <DialogFooter className="sm:col-span-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving..." : editing ? "Save Changes" : "Add Schedule"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete schedule"
        description={
          deleting
            ? `Remove "${deleting.subject}" on ${DAY_NAMES[deleting.dayOfWeek]} (${formatTime(deleting.startTime)}) from the timetable?`
            : ""
        }
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
      />
    </div>
  );
}
