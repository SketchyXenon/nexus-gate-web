"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart3, Clock, TrendingUp, Trophy } from "lucide-react";
import { motion } from "framer-motion";
import { useDashboardStats } from "@/lib/api-client";
import { format } from "date-fns";

const scansChartConfig: ChartConfig = {
  count: { label: "Scans", color: "var(--primary)" },
};

const hourChartConfig: ChartConfig = {
  count: { label: "Scans", color: "var(--primary)" },
};

const sourceChartConfig: ChartConfig = {
  qr: { label: "QR Scan", color: "var(--primary)" },
  override: { label: "Manual", color: "var(--muted-foreground)" },
};

// Compact date label: "Jul 5"
const shortDate = (iso: string): string => {
  try {
    return format(new Date(iso + "T00:00:00"), "MMM d");
  } catch {
    return iso;
  }
};

export function AnalyticsCharts() {
  const { data, isLoading } = useDashboardStats();

  if (isLoading || !data) {
    return (
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  const totalScans = data.scansBySource.qr + data.scansBySource.override;
  const peakHour = data.scansByHour.reduce(
    (max, h) => (h.count > max.count ? h : max),
    { hour: 0, count: 0 },
  );
  const topEvent = data.topEvents[0];

  return (
    <div className="space-y-4">
      {/* Summary strip */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <MiniStat
          icon={TrendingUp}
          label="Scans (30d)"
          value={data.scansByDay.reduce((s, d) => s + d.count, 0)}
        />
        <MiniStat
          icon={BarChart3}
          label="QR vs Manual"
          value={
            totalScans > 0
              ? `${Math.round((data.scansBySource.qr / totalScans) * 100)}%`
              : "—"
          }
        />
        <MiniStat
          icon={Clock}
          label="Peak hour"
          value={peakHour.count > 0 ? `${peakHour.hour}:00` : "—"}
        />
        <MiniStat
          icon={Trophy}
          label="Top event"
          value={topEvent ? `${topEvent.presentCount}` : "—"}
        />
      </div>

      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        {/* Scans over time (area chart) */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
        >
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="h-4 w-4 text-primary" />
                Scans over time
              </CardTitle>
              <CardDescription>Last 30 days</CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <ChartContainer config={scansChartConfig} className="h-48 w-full">
                <AreaChart data={data.scansByDay} margin={{ left: -20, right: 8, top: 8 }}>
                  <defs>
                    <linearGradient id="scansGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={shortDate}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    interval="preserveStartEnd"
                    minTickGap={24}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    allowDecimals={false}
                    width={32}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(_, payload) =>
                          payload?.[0]?.payload?.date
                            ? format(new Date(payload[0].payload.date + "T00:00:00"), "EEE, MMM d")
                            : ""
                        }
                      />
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="count"
                    stroke="var(--primary)"
                    strokeWidth={2}
                    fill="url(#scansGradient)"
                  />
                </AreaChart>
              </ChartContainer>
            </CardContent>
          </Card>
        </motion.div>

        {/* Scans by hour of day (bar chart) */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.05 }}
        >
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock className="h-4 w-4 text-primary" />
                Peak check-in hours
              </CardTitle>
              <CardDescription>When students scan most</CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <ChartContainer config={hourChartConfig} className="h-48 w-full">
                <BarChart data={data.scansByHour} margin={{ left: -20, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis
                    dataKey="hour"
                    tickFormatter={(h) => `${h}h`}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 10 }}
                    interval={2}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    allowDecimals={false}
                    width={32}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(_, payload) =>
                          payload?.[0]?.payload?.hour !== undefined
                            ? `${payload[0].payload.hour}:00 - ${payload[0].payload.hour}:59`
                            : ""
                        }
                      />
                    }
                  />
                  <Bar dataKey="count" fill="var(--primary)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Top events + source breakdown */}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-3">
        {/* Top events list */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.1 }}
          className="lg:col-span-2"
        >
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Trophy className="h-4 w-4 text-primary" />
                Top events by attendance
              </CardTitle>
              <CardDescription>Most-attended events</CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              {data.topEvents.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No events with attendance yet.
                </p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto ng-scroll">
                  {data.topEvents.map((e, i) => {
                    const maxCount = data.topEvents[0]?.presentCount || 1;
                    const pct = Math.round((e.presentCount / maxCount) * 100);
                    return (
                      <div key={e.id} className="flex items-center gap-3">
                        <span className="text-xs font-mono text-muted-foreground w-5 text-right">
                          {i + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <p className="text-sm font-medium truncate">{e.title}</p>
                            <span className="text-xs text-muted-foreground shrink-0">
                              {e.presentCount} present
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-muted mt-1 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-primary transition-all duration-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Source breakdown (pie) */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.15 }}
        >
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <BarChart3 className="h-4 w-4 text-primary" />
                Scan source
              </CardTitle>
              <CardDescription>QR vs manual</CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              {totalScans === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No scans recorded yet.
                </p>
              ) : (
                <ChartContainer config={sourceChartConfig} className="h-48 w-full">
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Pie
                      data={[
                        { name: "qr", value: data.scansBySource.qr, fill: "var(--primary)" },
                        { name: "override", value: data.scansBySource.override, fill: "var(--muted-foreground)" },
                      ]}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={45}
                      outerRadius={70}
                      paddingAngle={2}
                    >
                      <Cell fill="var(--primary)" />
                      <Cell fill="var(--muted-foreground)" />
                    </Pie>
                  </PieChart>
                </ChartContainer>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}

function MiniStat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof TrendingUp;
  label: string;
  value: string | number;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border bg-card p-3">
      <div className="grid place-items-center h-8 w-8 rounded-md bg-primary/10 text-primary shrink-0">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">
          {label}
        </p>
        <p className="text-sm font-bold truncate">{value}</p>
      </div>
    </div>
  );
}
