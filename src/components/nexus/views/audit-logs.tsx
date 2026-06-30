"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  ScrollText, Search, Loader2, ChevronLeft, ChevronRight,
} from "lucide-react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useAuditLogs } from "@/lib/api-client";
import { format } from "date-fns";

// Decide a colour tone for an action string by matching common keywords.
//   green  → sign-in, create, scan, verify, register, activate
//   amber  → update, cancel, override, import, resend
//   red    → delete, failed, suspend, revoke
//   muted  → everything else (e.g. logout)
function actionTone(action: string): string {
  const a = action.toLowerCase();
  if (
    a.includes("delete") ||
    a.includes("failed") ||
    a.includes("suspend") ||
    a.includes("revoke")
  ) {
    return "border-red-500/40 text-red-600";
  }
  if (
    (a.includes("login") && !a.includes("logout")) ||
    a.includes("create") ||
    a.includes("scan") ||
    a.includes("verify") ||
    a.includes("register") ||
    a.includes("activate")
  ) {
    return "border-emerald-500/40 text-emerald-600";
  }
  if (
    a.includes("update") ||
    a.includes("cancel") ||
    a.includes("override") ||
    a.includes("import") ||
    a.includes("resend")
  ) {
    return "border-amber-500/40 text-amber-600";
  }
  return "border-muted text-muted-foreground";
}

// Try to pretty-print a JSON metadata blob; fall back to the raw string.
function prettyMetadata(raw: string | null): string {
  if (!raw) return "—";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function AuditLogsView() {
  const [action, setAction] = useState("");
  const [actorSearch, setActorSearch] = useState("");
  const [sortBy, setSortBy] = useState("date-desc");
  const [page, setPage] = useState(1);
  const { data, isLoading, isError } = useAuditLogs({
    action: action || undefined,
    page,
  });
  const rawLogs = data?.logs ?? [];
  // Client-side actor search + sorting
  const logs = rawLogs
    .filter((l) => !actorSearch || (l.actor?.fullName || "").toLowerCase().includes(actorSearch.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === "date-asc") return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (sortBy === "action-asc") return a.action.localeCompare(b.action);
      if (sortBy === "action-desc") return b.action.localeCompare(a.action);
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(); // date-desc
    });
  const pagination = data?.pagination;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ScrollText className="h-5 w-5 text-primary" />
              Activity log
            </CardTitle>
            <CardDescription>
              {pagination?.total ?? 0}{" "}
              {pagination?.total === 1 ? "entry" : "entries"} · append-only record of who did what
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Filter by action…"
                value={action}
                onChange={(e) => { setAction(e.target.value); setPage(1); }}
                className="pl-8 w-44"
              />
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Filter by person…"
                value={actorSearch}
                onChange={(e) => setActorSearch(e.target.value)}
                className="pl-8 w-44"
              />
            </div>
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="date-desc">Newest first</SelectItem>
                <SelectItem value="date-asc">Oldest first</SelectItem>
                <SelectItem value="action-asc">Action A-Z</SelectItem>
                <SelectItem value="action-desc">Action Z-A</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isError && (
          <div className="px-6 pb-4">
            <p className="text-sm text-destructive">
              Couldn&apos;t load activity log. Please try again.
            </p>
          </div>
        )}
        <div className="max-h-[36rem] overflow-y-auto ng-scroll">
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>What they did</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>IP address</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
                    <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                    Loading activity…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && logs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
                    No activity matches your filter.
                  </TableCell>
                </TableRow>
              )}
              {logs.map((log, idx) => (
                <motion.tr
                  key={log.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18, delay: Math.min(idx * 0.012, 0.12) }}
                  className="hover:bg-muted/40"
                >
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                    {format(new Date(log.createdAt), "MMM d, HH:mm:ss")}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={`text-[11px] font-mono ${actionTone(log.action)}`}
                    >
                      {log.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {log.actor ? (
                      <div className="flex flex-col">
                        <span className="font-medium">{log.actor.fullName}</span>
                        <span className="text-muted-foreground">{log.actor.email}</span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">System</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground font-mono">
                    {log.targetType ? `${log.targetType} #${log.targetId ?? "?"}` : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground font-mono">
                    {log.ipAddress ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {log.metadata ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="font-mono block max-w-[220px] truncate cursor-help">
                            {log.metadata}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-md">
                          <pre className="text-[10px] whitespace-pre-wrap font-mono">
                            {prettyMetadata(log.metadata)}
                          </pre>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </motion.tr>
              ))}
            </TableBody>
          </Table>
        </div>

        {pagination && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 px-4 py-3 border-t">
            <p className="text-xs text-muted-foreground">
              Page {pagination.page} of {pagination.totalPages} · {pagination.total} entr{pagination.total === 1 ? "y" : "ies"} total
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={pagination.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
                Prev
              </Button>
              <span className="text-xs text-muted-foreground px-1">
                {pagination.page} / {pagination.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={pagination.page >= pagination.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
