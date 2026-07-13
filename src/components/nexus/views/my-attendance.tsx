"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  CalendarDays,
  ScanLine,
  Clock,
  CheckCircle2,
  Filter,
  GraduationCap,
  Building2,
  Download,
  TrendingUp,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMyAttendance, type MyAttendanceRecord } from "@/lib/api-client";
import { AttendanceTrends } from "@/components/nexus/attendance-trends";
import { getProgramLabel } from "@/lib/programs";
import { toast } from "@/hooks/use-toast";
import { format, parseISO } from "date-fns";

const sourceLabel = (s: string): string =>
  s === "override" ? "Manual entry" : "QR scan";

const sourceBadgeClass = (s: string): string =>
  s === "override"
    ? "border-amber-500/40 text-amber-600"
    : "border-emerald-500/40 text-emerald-600";

const scopeIcon = (scope: string) =>
  scope === "departmental" ? Building2 : GraduationCap;

const scopeLabel = (scope: string): string =>
  scope === "departmental" ? "Departmental" : "Academic";

export function MyAttendanceView() {
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  const { data, isLoading } = useMyAttendance({
    from: fromDate || undefined,
    to: toDate || undefined,
    scope: scopeFilter !== "all" ? scopeFilter : undefined,
  });

  const records = data?.records ?? [];
  const stats = data?.stats;

  // Group records by month for display.
  const groupedByMonth = useMemo(() => {
    const map = new Map<string, MyAttendanceRecord[]>();
    for (const r of records) {
      try {
        const key = format(parseISO(r.scannedAt), "MMMM yyyy");
        const list = map.get(key) ?? [];
        list.push(r);
        map.set(key, list);
      } catch {
        // skip malformed
      }
    }
    return Array.from(map.entries());
  }, [records]);

  const exportCsv = () => {
    if (records.length === 0) {
      toast({
        title: "Nothing to export",
        description: "You have no attendance records to export.",
        variant: "destructive",
      });
      return;
    }
    const escape = (v: string | number | null | undefined): string => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };
    const header = "Event,Scope,Program,Section,Check-in,Time-out,Source\n";
    const body = records
      .map((r) => {
        const evt = r.event;
        return [
          escape(evt.title),
          escape(scopeLabel(evt.scope)),
          escape(evt.targetProgram),
          escape(evt.targetSection),
          escape(format(parseISO(r.scannedAt), "yyyy-MM-dd HH:mm:ss")),
          r.timeOutAt ? escape(format(parseISO(r.timeOutAt), "yyyy-MM-dd HH:mm:ss")) : "",
          escape(sourceLabel(r.source)),
        ].join(",");
      })
      .join("\n");
    const blob = new Blob([header + body], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `my-attendance-${format(new Date(), "yyyy-MM-dd")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "CSV downloaded", description: `${records.length} records exported.` });
  };

  return (
    <div className="space-y-6">
      {/* Stats cards */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard
          icon={CheckCircle2}
          label="Total check-ins"
          value={stats?.total ?? 0}
        />
        <StatCard
          icon={ScanLine}
          label="QR scans"
          value={stats?.qrCount ?? 0}
        />
        <StatCard
          icon={Clock}
          label="Time-outs"
          value={stats?.withTimeout ?? 0}
        />
        <StatCard
          icon={TrendingUp}
          label="Attendance rate"
          value={stats && stats.total > 0 ? `${stats.qrCount}/${stats.total}` : "—"}
        />
      </div>

      {/* Attendance trends chart */}
      <AttendanceTrends />

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Filter className="h-4 w-4 text-primary" />
            Filter your history
          </CardTitle>
          <CardDescription>Narrow down by date range or event type</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 grid-cols-1 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">From</Label>
            <Input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">To</Label>
            <Input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Event type</Label>
            <Select value={scopeFilter} onValueChange={setScopeFilter}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="academic">Academic</SelectItem>
                <SelectItem value="departmental">Departmental</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Records list */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <CalendarDays className="h-4 w-4 text-primary" />
                Your attendance history
              </CardTitle>
              <CardDescription className="mt-1">
                {records.length} record{records.length === 1 ? "" : "s"}
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" className="h-8" onClick={exportCsv}>
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-lg" />
              ))}
            </div>
          ) : records.length === 0 ? (
            <div className="p-8 text-center">
              <CalendarDays className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No attendance records yet.
              </p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                Once you scan into an event, it&apos;ll show up here.
              </p>
            </div>
          ) : (
            <div className="divide-y max-h-[600px] overflow-y-auto ng-scroll">
              {groupedByMonth.map(([month, monthRecords]) => (
                <div key={month}>
                  {/* Month header */}
                  <div className="sticky top-0 z-10 bg-muted/50 backdrop-blur-sm px-4 sm:px-6 py-1.5 border-b">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      {month}
                    </p>
                  </div>
                  {/* Records */}
                  {monthRecords.map((r, i) => {
                    const Icon = scopeIcon(r.event.scope);
                    const scheduled = parseISO(r.scannedAt);
                    return (
                      <motion.div
                        key={r.id}
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.25, delay: i * 0.03 }}
                        className="px-4 sm:px-6 py-3 flex items-center gap-3 hover:bg-muted/30 transition-colors"
                      >
                        <div className="grid place-items-center h-10 w-10 rounded-lg bg-primary/10 text-primary shrink-0">
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">
                            {r.event.title}
                          </p>
                          <p className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
                            <Clock className="h-3 w-3" />
                            {format(scheduled, "EEE, MMM d 'at' h:mm a")}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5 truncate">
                            {r.event.targetProgram
                              ? (getProgramLabel(r.event.targetProgram) ?? r.event.targetProgram)
                              : "All programs"}
                            {r.event.targetSection ? ` · ${r.event.targetSection}` : ""}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <Badge variant="outline" className={`text-[10px] ${sourceBadgeClass(r.source)}`}>
                            {sourceLabel(r.source)}
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            {scopeLabel(r.event.scope)}
                          </Badge>
                          {r.timeOutAt && (
                            <span className="text-[10px] text-muted-foreground">
                              Out: {format(parseISO(r.timeOutAt), "h:mm a")}
                            </span>
                          )}
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: string | number;
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-center gap-2.5">
          <div className="grid place-items-center h-8 w-8 rounded-md bg-primary/10 text-primary shrink-0">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">
              {label}
            </p>
            <p className="text-lg sm:text-xl font-bold truncate">{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
