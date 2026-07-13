"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
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
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Flame, Trophy } from "lucide-react";
import { motion } from "framer-motion";
import { useMyStats } from "@/lib/api-client";
import { format } from "date-fns";

const chartConfig: ChartConfig = {
  count: { label: "Check-ins", color: "var(--primary)" },
};

const shortMonth = (ym: string): string => {
  try {
    return format(new Date(ym + "-01T00:00:00"), "MMM");
  } catch {
    return ym;
  }
};

export function AttendanceTrends() {
  const { data, isLoading } = useMyStats();

  if (isLoading || !data) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-4 w-4 text-primary" />
            Attendance trends
          </CardTitle>
          <CardDescription>Last 6 months</CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <Skeleton className="h-40 w-full rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  const totalScans = data.scansByMonth.reduce((s, m) => s + m.count, 0);
  const peakMonth = data.scansByMonth.reduce(
    (max, m) => (m.count > max.count ? m : max),
    { month: "", count: 0 },
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="h-4 w-4 text-primary" />
                Attendance trends
              </CardTitle>
              <CardDescription>Last 6 months</CardDescription>
            </div>
            <div className="flex gap-1.5 flex-wrap justify-end">
              <Badge variant="outline" className="gap-1 text-[10px]">
                <Flame className="h-3 w-3 text-amber-500" />
                {data.streak.current}mo streak
              </Badge>
              <Badge variant="outline" className="gap-1 text-[10px]">
                <Trophy className="h-3 w-3 text-primary" />
                Best: {data.streak.longest}mo
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <ChartContainer config={chartConfig} className="h-40 w-full">
            <AreaChart data={data.scansByMonth} margin={{ left: -20, right: 8, top: 8 }}>
              <defs>
                <linearGradient id="myScansGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="month"
                tickFormatter={shortMonth}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11 }}
                interval={0}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11 }}
                allowDecimals={false}
                width={28}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) =>
                      payload?.[0]?.payload?.month
                        ? format(new Date(payload[0].payload.month + "-01T00:00:00"), "MMMM yyyy")
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
                fill="url(#myScansGradient)"
              />
            </AreaChart>
          </ChartContainer>

          {/* Summary row */}
          <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-border/50">
            <div className="text-center">
              <p className="text-lg font-bold tabular-nums">{totalScans}</p>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                6-month total
              </p>
            </div>
            <div className="text-center">
              <p className="text-lg font-bold tabular-nums">
                {data.byScope.academic}
              </p>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Academic
              </p>
            </div>
            <div className="text-center">
              <p className="text-lg font-bold tabular-nums">
                {data.byScope.departmental}
              </p>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Departmental
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
