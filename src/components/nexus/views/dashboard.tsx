"use client";

import {
  Users,
  CalendarDays,
  ScanLine,
  AlertTriangle,
  AlertCircle,
  ArrowRight,
  TrendingUp,
  Activity,
  CheckCircle2,
  BarChart3,
  Download,
  Info,
  type LucideIcon,
} from "lucide-react";
import { motion } from "framer-motion";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useDashboard,
  useRecentAttendance,
  type Account,
} from "@/lib/api-client";
import { ROLE_LABELS } from "@/lib/rbac";
import { getProgramLabel } from "@/lib/programs";
import { MaintenancePanel } from "@/components/nexus/maintenance";
import { format } from "date-fns";

type ViewId =
  | "dashboard"
  | "whitelist"
  | "events"
  | "project-qr"
  | "scanner"
  | "attendance"
  | "overrides"
  | "profile";

interface Props {
  user: Account;
  onNavigate: (v: ViewId) => void;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

const scopeLabel = (s: string) =>
  s === "departmental" ? "Department-wide" : s === "academic" ? "Academic" : s;

const sourceLabel = (s: string) =>
  s === "override" ? "Added manually" : "Scanned";

// Safe max(): avoids Math.max(...arr) call-stack risk on unbounded arrays.
const safeMax = (arr: number[], fallback = 1): number =>
  arr.length === 0 ? fallback : arr.reduce((a, b) => (b > a ? b : a), fallback);

export function DashboardView({ user, onNavigate }: Props) {
  const { data, isLoading } = useDashboard();

  if (isLoading || !data) {
    return (
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
    );
  }

  const {
    stats,
    recentEvents,
    attendances,
    programCounts,
    sectionCounts,
    needsProfile,
  } = data;

  // ---------- Student (USER) dashboard ----------
  if (user.role === "USER") {
    return (
      <div className="space-y-6">
        {/* Profile completion prompt */}
        {needsProfile && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <Card className="border-amber-500/40 bg-amber-500/5">
              <CardContent className="p-3 sm:p-4 flex flex-wrap items-center gap-2">
                <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
                <p className="font-medium text-amber-700 dark:text-amber-400 flex-1 min-w-[12rem] text-sm">
                  Complete your profile to see events for your course
                </p>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-amber-600/70 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Your course and section aren&apos;t set. Fill them out in
                    your profile to see attendance events for your class.
                  </TooltipContent>
                </Tooltip>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 border-amber-500/40 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
                  onClick={() => onNavigate("profile")}
                >
                  Go to profile
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        )}

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <Card className="relative overflow-hidden border-primary/20">
            <div className="absolute -top-16 -right-16 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
            <CardContent className="relative p-4 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                  Your dashboard
                </p>
                <h2 className="text-xl sm:text-2xl font-bold tracking-tight truncate">
                  Welcome, {firstName(user.fullName)}
                </h2>
                <p className="text-sm text-muted-foreground mt-1 truncate">
                  {user.program && user.section
                    ? `${getProgramLabel(user.program) ?? user.program} · Section ${user.section}`
                    : "Student"}
                  {user.studentId ? ` · ${user.studentId}` : ""}
                </p>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={() => onNavigate("scanner")}
                    className="h-10 shrink-0"
                  >
                    <ScanLine className="h-4 w-4" />
                    Scan to check in
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Open the QR scanner</TooltipContent>
              </Tooltip>
            </CardContent>
          </Card>
        </motion.div>

        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.05 }}
            className="h-full min-w-0"
          >
            <StatCard
              label="Events you've attended"
              value={stats.totalAttended ?? 0}
              hint="Total check-ins recorded"
              icon={CheckCircle2}
            />
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.1 }}
            className="h-full min-w-0"
          >
            <StatCard
              label="Events available to you"
              value={stats.eligibleEvents ?? 0}
              hint="Active events for your section"
              icon={CalendarDays}
            />
          </motion.div>
        </div>

        <Card>
          <CardHeader className="p-4 sm:p-6">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-primary" />
              Your attendance history
            </CardTitle>
            <CardDescription>
              Every event you&apos;ve checked in to
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y max-h-80 overflow-y-auto ng-scroll">
              {(!attendances || attendances.length === 0) && (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  No check-ins yet. Scan a QR code at your next event to get
                  started.
                </div>
              )}
              {attendances?.map((a, i) => (
                <motion.div
                  key={a.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, delay: i * 0.04 }}
                  className="px-4 sm:px-6 py-3 flex items-center gap-3"
                >
                  <div className="grid place-items-center h-9 w-9 rounded-lg bg-primary/10 text-primary shrink-0">
                    <CheckCircle2 className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {a.event.title}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {format(new Date(a.scannedAt), "PPp")}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      a.source === "override"
                        ? "border-amber-500/40 text-amber-600 shrink-0"
                        : "border-emerald-500/40 text-emerald-600 shrink-0"
                    }
                  >
                    {sourceLabel(a.source)}
                  </Badge>
                </motion.div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---------- Admin / Organizer dashboard ----------
  const cards: Array<{
    label: string;
    value: number;
    icon: LucideIcon;
    hint: string;
    view: ViewId;
    show: boolean;
  }> = (
    [
      {
        label: "Approved students",
        value: stats.totalStudents ?? 0,
        icon: Users,
        hint: "On the approved list",
        view: "whitelist" as ViewId,
        show: user.role === "ADMIN",
      },
      {
        label: "Active events",
        value: stats.totalEvents ?? 0,
        icon: CalendarDays,
        hint: "Classes and gatherings",
        view: "events" as ViewId,
        show: true,
      },
      {
        label: "Total check-ins",
        value: stats.totalScans ?? 0,
        icon: ScanLine,
        hint: "Attendance records",
        view: "attendance" as ViewId,
        show: true,
      },
      {
        label: "Manual entries",
        value: stats.totalOverrides ?? 0,
        icon: AlertTriangle,
        hint: "Added by hand",
        view: "overrides" as ViewId,
        show: true,
      },
    ] as Array<{
      label: string;
      value: number;
      icon: LucideIcon;
      hint: string;
      view: ViewId;
      show: boolean;
    }>
  ).filter((c) => c.show);

  const maxProgram = safeMax(Object.values(programCounts ?? {}));

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <Card className="relative overflow-hidden border-primary/20">
          <div className="absolute -top-16 -right-16 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
          <CardContent className="relative p-4 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                {ROLE_LABELS[user.role]} overview
              </p>
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight truncate">
                Welcome, {firstName(user.fullName)}
              </h2>
              <p className="text-sm text-muted-foreground mt-1 truncate">
                {user.program && user.section
                  ? `${getProgramLabel(user.program) ?? user.program} · Section ${user.section}`
                  : "Attendance System"}
              </p>
            </div>
            <div className="flex gap-2 flex-wrap shrink-0">
              {user.role === "ORGANIZER" && (
                <Button
                  onClick={() => onNavigate("project-qr")}
                  className="h-10"
                >
                  <ScanLine className="h-4 w-4" />
                  Show QR code
                </Button>
              )}
              {user.role === "ADMIN" && (
                <Button
                  variant="outline"
                  onClick={() => onNavigate("whitelist")}
                  className="h-10"
                >
                  <Users className="h-4 w-4" />
                  Manage approved students
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </motion.div>

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        {cards.map((c, i) => {
          const Icon = c.icon;
          return (
            <motion.div
              key={c.label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: i * 0.05 }}
              className="h-full min-w-0"
            >
              <Card
                className="group hover:border-primary/40 transition-colors cursor-pointer h-full min-w-0 overflow-hidden"
                onClick={() => onNavigate(c.view)}
              >
                <CardHeader className="flex flex-row items-center justify-between pb-2 p-4 sm:p-6 sm:pb-2">
                  <CardTitle className="text-xs font-medium text-muted-foreground leading-tight">
                    {c.label}
                  </CardTitle>
                  <div className="grid place-items-center h-8 w-8 rounded-lg bg-primary/10 text-primary shrink-0">
                    <Icon className="h-4 w-4" />
                  </div>
                </CardHeader>
                <CardContent className="p-4 sm:p-6 sm:pt-0">
                  <div className="text-2xl sm:text-3xl font-bold tracking-tight">
                    {c.value.toLocaleString()}
                  </div>
                  <div className="flex items-center justify-between mt-2 gap-2">
                    <p className="text-[11px] text-muted-foreground truncate">
                      {c.hint}
                    </p>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all shrink-0" />
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2 min-w-0 overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between gap-2 p-4 sm:p-6">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="h-4 w-4 text-primary shrink-0" />
                Recent events
              </CardTitle>
              <CardDescription className="truncate">
                The latest classes and gatherings
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onNavigate("attendance")}
              className="h-9 shrink-0"
            >
              View all
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y max-h-80 overflow-y-auto ng-scroll">
              {(!recentEvents || recentEvents.length === 0) && (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  No events yet. Create one on the Events page to get started.
                </div>
              )}
              {recentEvents?.map((e, i) => (
                <motion.div
                  key={e.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, delay: i * 0.04 }}
                  className="px-4 sm:px-6 py-3 flex items-center gap-3 hover:bg-muted/40 transition-colors"
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="grid place-items-center h-9 w-9 rounded-lg bg-primary/10 text-primary text-xs font-semibold shrink-0 cursor-pointer">
                        {e.presentCount}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      {e.presentCount} students present
                    </TooltipContent>
                  </Tooltip>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{e.title}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {e.targetProgram
                        ? (getProgramLabel(e.targetProgram) ?? e.targetProgram)
                        : "All programs"}
                      {e.targetSection ? ` · ${e.targetSection}` : ""} ·{" "}
                      {format(new Date(e.scheduledAt), "MMM d, HH:mm")}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <Badge
                      variant="outline"
                      className={
                        e.timeStatus === "live"
                          ? "border-emerald-500/40 text-emerald-600"
                          : e.timeStatus === "upcoming"
                            ? "border-amber-500/40 text-amber-600"
                            : e.timeStatus === "ended"
                              ? "border-muted text-muted-foreground"
                              : "border-red-500/40 text-red-600"
                      }
                    >
                      {e.timeStatus === "live"
                        ? "Live now"
                        : e.timeStatus === "upcoming"
                          ? "Upcoming"
                          : e.timeStatus === "ended"
                            ? "Ended"
                            : "Cancelled"}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={
                        e.scope === "departmental"
                          ? "border-amber-500/40 text-amber-600 text-[10px]"
                          : "border-emerald-500/40 text-emerald-600 text-[10px]"
                      }
                    >
                      {scopeLabel(e.scope)}
                    </Badge>
                  </div>
                </motion.div>
              ))}
            </div>
          </CardContent>
        </Card>

        <RecentCheckInsCard onNavigate={onNavigate} />

        <Card>
          <CardHeader className="p-4 sm:p-6">
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4 text-primary" />
              Students by group
            </CardTitle>
            <CardDescription>Approved list breakdown</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 p-4 sm:p-6 sm:pt-0">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
                Programs
              </p>
              <div className="space-y-1.5">
                {Object.entries(programCounts ?? {}).length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No students on the approved list yet.
                  </p>
                )}
                {Object.entries(programCounts ?? {}).map(([prog, count]) => (
                  <div key={prog} className="flex items-center gap-2">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-xs w-16 sm:w-20 font-medium truncate cursor-help">
                          {prog}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {getProgramLabel(prog) ?? prog}
                      </TooltipContent>
                    </Tooltip>
                    <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${(count / maxProgram) * 100}%` }}
                        transition={{ duration: 0.6, ease: "easeOut" }}
                        className="h-full bg-primary rounded-full"
                      />
                    </div>
                    <span className="text-xs text-muted-foreground w-6 text-right">
                      {count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
                Sections
              </p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(sectionCounts ?? {}).length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No sections yet.
                  </p>
                )}
                {Object.entries(sectionCounts ?? {}).map(([sec, count]) => (
                  <Badge key={sec} variant="secondary" className="text-[11px]">
                    {sec} · {count}
                  </Badge>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {user.role === "ADMIN" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <MaintenancePanel />
          <AnalyticsPanel
            stats={stats}
            recentEvents={recentEvents}
            programCounts={programCounts}
          />
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: number;
  hint: string;
  icon: LucideIcon;
}) {
  return (
    <Card className="h-full min-w-0 overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between pb-2 p-4 sm:p-6 sm:pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground leading-tight">
          {label}
        </CardTitle>
        <div className="grid place-items-center h-8 w-8 rounded-lg bg-primary/10 text-primary shrink-0">
          <Icon className="h-4 w-4" />
        </div>
      </CardHeader>
      <CardContent className="p-4 sm:p-6 sm:pt-0">
        <div className="text-2xl sm:text-3xl font-bold tracking-tight">
          {value.toLocaleString()}
        </div>
        <p className="text-[11px] text-muted-foreground mt-1 truncate">
          {hint}
        </p>
      </CardContent>
    </Card>
  );
}

// ====================================================================
// AnalyticsPanel — admin-only snapshot of the whole system.
//
// Shows three headline metrics (Students / Events / Attendance rate %),
// a top-6 program distribution bar chart, and a top-5 events list
// ranked by attendance. Includes a CSV export of all metrics.
// Falls back to an empty state when no activity has been recorded.
// ====================================================================
interface AnalyticsStats {
  totalStudents?: number;
  totalEvents?: number;
  totalScans?: number;
  totalOverrides?: number;
}

interface AnalyticsEvent {
  id: number;
  title: string;
  presentCount: number;
}

function AnalyticsPanel({
  stats,
  recentEvents,
  programCounts,
}: {
  stats: AnalyticsStats;
  recentEvents?: AnalyticsEvent[];
  programCounts?: Record<string, number>;
}) {
  const totalStudents = stats.totalStudents ?? 0;
  const totalEvents = stats.totalEvents ?? 0;
  const totalScans = stats.totalScans ?? 0;
  // Average fraction of student-event pairs with a recorded check-in.
  const attendanceRate =
    totalStudents > 0 && totalEvents > 0
      ? Math.min(
          100,
          Math.round((totalScans / (totalStudents * totalEvents)) * 100),
        )
      : 0;

  const topPrograms = Object.entries(programCounts ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const maxProgramCount = safeMax(topPrograms.map(([, c]) => c));

  const topEvents = [...(recentEvents ?? [])]
    .sort((a, b) => b.presentCount - a.presentCount)
    .slice(0, 5);
  const maxEventCount = safeMax(topEvents.map((e) => e.presentCount));

  const hasActivity = totalStudents > 0 || totalEvents > 0 || totalScans > 0;

  function handleExport() {
    const rows: Array<Array<string | number>> = [["metric", "value"]];
    rows.push(["students", totalStudents]);
    rows.push(["events", totalEvents]);
    rows.push(["total_check_ins", totalScans]);
    rows.push(["attendance_rate_pct", attendanceRate]);
    rows.push([]);
    rows.push(["program", "students"]);
    topPrograms.forEach(([p, c]) => rows.push([p, c]));
    rows.push([]);
    rows.push(["event", "present_count"]);
    topEvents.forEach((e) => rows.push([e.title, e.presentCount]));
    const csv = rows
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `nexus-analytics-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-2 p-4 sm:p-6">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4 text-primary shrink-0" />
            Analytics snapshot
          </CardTitle>
          <CardDescription className="truncate">
            Key metrics across the system
          </CardDescription>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleExport}
              disabled={!hasActivity}
              className="h-9 shrink-0"
            >
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline">Export CSV</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Download these metrics as a CSV file</TooltipContent>
        </Tooltip>
      </CardHeader>
      <CardContent className="space-y-4 sm:space-y-6 p-4 sm:p-6 sm:pt-0">
        {!hasActivity ? (
          <div className="text-center py-8">
            <BarChart3 className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm font-medium text-muted-foreground">
              No activity yet
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Once students start checking in, you&apos;ll see live metrics
              here.
            </p>
          </div>
        ) : (
          <>
            {/* 3 key metrics */}
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              <div className="rounded-lg border bg-muted/30 p-2 sm:p-3">
                <p className="text-[10px] sm:text-[11px] uppercase tracking-wide text-muted-foreground truncate">
                  Students
                </p>
                <p className="text-xl sm:text-2xl font-bold tracking-tight mt-1">
                  {totalStudents.toLocaleString()}
                </p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-2 sm:p-3">
                <p className="text-[10px] sm:text-[11px] uppercase tracking-wide text-muted-foreground truncate">
                  Events
                </p>
                <p className="text-xl sm:text-2xl font-bold tracking-tight mt-1">
                  {totalEvents.toLocaleString()}
                </p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-2 sm:p-3">
                <p className="text-[10px] sm:text-[11px] uppercase tracking-wide text-muted-foreground truncate">
                  Attendance
                </p>
                <p className="text-xl sm:text-2xl font-bold tracking-tight mt-1">
                  {attendanceRate}%
                </p>
              </div>
            </div>

            {/* Program distribution (top 6) */}
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
                Program distribution
                {topPrograms.length > 0 && ` (top ${topPrograms.length})`}
              </p>
              {topPrograms.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No students on the approved list yet.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {topPrograms.map(([prog, count], i) => (
                    <div key={prog} className="flex items-center gap-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-xs w-16 sm:w-20 font-medium truncate cursor-help">
                            {prog}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          {getProgramLabel(prog) ?? prog}
                        </TooltipContent>
                      </Tooltip>
                      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{
                            width: `${(count / maxProgramCount) * 100}%`,
                          }}
                          transition={{
                            duration: 0.6,
                            ease: "easeOut",
                            delay: i * 0.05,
                          }}
                          className="h-full bg-primary rounded-full"
                        />
                      </div>
                      <span className="text-xs text-muted-foreground w-8 text-right">
                        {count}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Top events by attendance (top 5) */}
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
                Top events by attendance
              </p>
              {topEvents.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No events recorded yet.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {topEvents.map((e, i) => (
                    <div key={e.id} className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium truncate">
                          {e.title}
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {e.presentCount}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{
                            width: `${(e.presentCount / maxEventCount) * 100}%`,
                          }}
                          transition={{
                            duration: 0.6,
                            ease: "easeOut",
                            delay: i * 0.05,
                          }}
                          className="h-full bg-primary/80 rounded-full"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// Recent check-ins across all events the organizer/admin can see.
function RecentCheckInsCard({
  onNavigate,
}: {
  onNavigate: (v: ViewId) => void;
}) {
  const { data, isLoading } = useRecentAttendance(15);
  const records = data?.records ?? [];

  return (
    <Card>
      <CardHeader className="p-4 sm:p-6">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-primary" />
              Recent check-ins
            </CardTitle>
            <CardDescription className="truncate">
              Latest attendance records
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onNavigate("attendance")}
            className="h-9 shrink-0"
          >
            View all
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y max-h-80 overflow-y-auto ng-scroll">
          {isLoading && (
            <div className="p-6 text-center text-sm text-muted-foreground">
              Loading recent check-ins…
            </div>
          )}
          {!isLoading && records.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No check-ins yet. Records are preserved after events end.
            </div>
          )}
          {records.map((r) => (
            <div
              key={r.id}
              className="px-4 sm:px-6 py-2.5 flex items-center gap-3 hover:bg-muted/40 transition-colors"
            >
              <div className="grid place-items-center h-8 w-8 rounded-full bg-primary/10 text-primary shrink-0 text-[10px] font-semibold">
                {(r.account.fullName || "?").charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {r.account.fullName}
                  {r.account.studentId && (
                    <span className="text-muted-foreground font-normal ml-1.5 tabular-nums">
                      #{r.account.studentId}
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {r.event.title}
                </p>
              </div>
              <div className="flex flex-col items-end gap-0.5 shrink-0">
                <Badge
                  variant="outline"
                  className={
                    r.source === "override"
                      ? "border-amber-500/40 text-amber-600 text-[10px]"
                      : "border-emerald-500/40 text-emerald-600 text-[10px]"
                  }
                >
                  {sourceLabel(r.source)}
                </Badge>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {format(new Date(r.scannedAt), "MMM d, HH:mm")}
                </span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
