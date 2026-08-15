"use client";

import { Users, Eye, TrendingUp } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAnalytics } from "@/lib/api-client";

// ====================================================================
// VisitAnalyticsCard — admin dashboard analytics summary.
// Privacy-preserving: the server stores only daily-hashed visitor tokens,
// never raw IPs. This card renders the 7-day aggregate.
// ====================================================================

export function VisitAnalyticsCard() {
  const { data, isLoading } = useAnalytics();

  if (isLoading || !data) {
    return <Skeleton className="h-40 rounded-xl" />;
  }

  const { totals, days, topRoutes } = data;
  const peakDay = days.reduce(
    (max, d) => (d.totalVisits > max.totalVisits ? d : max),
    days[0] ?? { day: "", totalVisits: 0 },
  );

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Eye className="h-4 w-4 text-primary" />
          Visit Analytics
        </CardTitle>
        <CardDescription className="text-xs">
          Last 7 days · privacy-preserving (no raw IP stored)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Users className="h-3 w-3" />
              Unique visitors
            </div>
            <p className="text-xl font-bold tracking-tight">
              {totals.uniqueVisitors.toLocaleString()}
            </p>
          </div>
          <div className="space-y-0.5">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <TrendingUp className="h-3 w-3" />
              Total visits
            </div>
            <p className="text-xl font-bold tracking-tight">
              {totals.totalVisits.toLocaleString()}
            </p>
          </div>
        </div>

        {/* 7-day sparkline bars */}
        <div className="flex items-end gap-1 h-12">
          {days.map((d) => {
            const max = Math.max(1, ...days.map((x) => x.totalVisits));
            const h = Math.max(4, Math.round((d.totalVisits / max) * 100));
            return (
              <div
                key={d.day}
                className="flex-1 rounded-sm bg-primary/20 hover:bg-primary/40 transition-colors"
                style={{ height: `${h}%` }}
                title={`${d.day}: ${d.totalVisits} visits`}
              />
            );
          })}
        </div>

        {topRoutes.length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] text-muted-foreground">Top routes</p>
            {topRoutes.slice(0, 3).map((r) => (
              <div
                key={r.route}
                className="flex items-center justify-between text-xs"
              >
                <span className="truncate font-mono text-muted-foreground">
                  {r.route}
                </span>
                <span className="font-medium">{r.visits}</span>
              </div>
            ))}
          </div>
        )}

        {peakDay.totalVisits > 0 && (
          <p className="text-[10px] text-muted-foreground">
            Peak: {peakDay.day} ({peakDay.totalVisits} visits)
          </p>
        )}
      </CardContent>
    </Card>
  );
}
