"use client";

import { format } from "date-fns";
import { motion } from "framer-motion";
import {
  Calendar,
  Clock,
  Users,
  GraduationCap,
  Globe2,
  CheckCircle2,
  Hourglass,
  AlertCircle,
  Loader2,
  DoorOpen,
  LogIn,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useEventDetails, type EventDetails } from "@/lib/api-client";

// ====================================================================
// Nexus Gate — Event Details Dialog
//
// Opens a shadcn Dialog showing the full event info for a single
// event. Pulls data from /api/events/[id]/details via the
// useEventDetails hook. The endpoint returns the caller's own
// attendance row for students, computed time-window status, and a
// human-readable program label.
// ====================================================================

interface EventDetailsDialogProps {
  /** The event id to load. When null, the dialog is closed. */
  eventId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EventDetailsDialog({
  eventId,
  open,
  onOpenChange,
}: EventDetailsDialogProps) {
  // The hook is `enabled` only when eventId != null, so it lazy-loads
  // the moment a row is clicked.
  const { data, isLoading, isError, error } = useEventDetails(eventId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-heading">
            {data?.title ?? "Event details"}
          </DialogTitle>
          <DialogDescription>
            Full details for this event, including check-in status and timing.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <DetailsSkeleton />
        ) : isError ? (
          <DetailsError error={error} />
        ) : data ? (
          <DetailsBody data={data} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ---- Error state ----
// Shows the actual server message (e.g. "This event isn't available to you")
// so the user understands why the dialog couldn't load — instead of a
// generic "try again" message.
function DetailsError({ error }: { error: unknown }) {
  const msg =
    error instanceof Error
      ? error.message
      : "We couldn't load this event's details.";
  // 403 / 404 → informational tone; 5xx / network → "try again"
  const status = (error as { status?: number } | null)?.status;
  const isForbidden = status === 403;
  const isNotFound = status === 404;
  const isAccessIssue = isForbidden || isNotFound;
  return (
    <div
      className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
        isAccessIssue
          ? "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400"
          : "border-destructive/40 bg-destructive/5 text-destructive"
      }`}
    >
      <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="space-y-1">
        <p className="font-medium">
          {isForbidden
            ? "You can't view this event"
            : isNotFound
            ? "Event not found"
            : "Couldn't load details"}
        </p>
        <p className="text-xs opacity-90">{msg}</p>
        {!isAccessIssue && (
          <p className="text-xs opacity-75">
            Please close and try again in a moment.
          </p>
        )}
      </div>
    </div>
  );
}

// ---- Body ----
function DetailsBody({ data }: { data: EventDetails }) {
  // Status badge: Live / Upcoming / Ended / Cancelled
  const status = deriveStatus(data);
  const scheduledAt = new Date(data.scheduledAt);
  const endsAt = data.endsAt ? new Date(data.endsAt) : null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="space-y-4"
    >
      {/* Status badge */}
      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge status={status} />
        <Badge variant="outline" className="capitalize">
          {data.scope === "academic" ? "One class" : "Department-wide"}
        </Badge>
      </div>

      {/* Description */}
      {data.description && (
        <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
          {data.description}
        </p>
      )}

      {/* Date / time */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <InfoRow
          icon={<Calendar className="h-4 w-4" />}
          label="Date"
          value={format(scheduledAt, "EEE, MMM d, yyyy")}
        />
        <InfoRow
          icon={<Clock className="h-4 w-4" />}
          label="Starts"
          value={format(scheduledAt, "p")}
        />
        {endsAt && (
          <InfoRow
            icon={<DoorOpen className="h-4 w-4" />}
            label="Ends"
            value={format(endsAt, "EEE, MMM d, p")}
          />
        )}
        <InfoRow
          icon={<Users className="h-4 w-4" />}
          label="Checked in"
          value={`${data.attendanceCount} student${data.attendanceCount === 1 ? "" : "s"}`}
        />
      </div>

      {/* Program / section */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <InfoRow
          icon={<GraduationCap className="h-4 w-4" />}
          label="Program"
          value={
            data.targetProgramLabel ?? data.targetProgram ?? "All programs"
          }
        />
        <InfoRow
          icon={<Globe2 className="h-4 w-4" />}
          label="Section"
          value={data.targetSection ?? "All sections"}
        />
      </div>

      {/* Check-in window */}
      <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <LogIn className="h-4 w-4 text-primary" />
          Check-in window
        </div>
        <p className="text-xs text-muted-foreground">
          Opens {format(new Date(data.windows.checkIn.opensAt), "MMM d, p")} ·
          Closes {format(new Date(data.windows.checkIn.closesAt), "MMM d, p")}
        </p>
        <WindowStatusPill
          isLive={data.windows.checkIn.isLive}
          isUpcoming={data.windows.checkIn.isUpcoming}
          isEnded={data.windows.checkIn.isEnded}
        />
      </div>

      {/* Time-out window (if enabled) */}
      {data.windows.timeOut && (
        <div className="rounded-md border border-muted p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <DoorOpen className="h-4 w-4" />
            Time-out window
          </div>
          <p className="text-xs text-muted-foreground">
            Opens {format(new Date(data.windows.timeOut.opensAt), "MMM d, p")} ·
            Closes {format(new Date(data.windows.timeOut.closesAt), "MMM d, p")}
          </p>
          <Badge
            variant="outline"
            className={
              data.windows.timeOut.isLive
                ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
                : ""
            }
          >
            {data.windows.timeOut.isLive ? "Open now" : "Closed"}
          </Badge>
        </div>
      )}

      {/* Student's own check-in status */}
      {data.myAttendance ? (
        <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
          <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <div>
            <p className="font-medium text-emerald-700 dark:text-emerald-400">
              You're checked in
            </p>
            <p className="text-xs text-muted-foreground">
              Scanned at {format(new Date(data.myAttendance.scannedAt), "MMM d, p")}
              {data.myAttendance.timeOutAt
                ? ` · Timed out at ${format(new Date(data.myAttendance.timeOutAt), "p")}`
                : ""}
            </p>
          </div>
        </div>
      ) : (
        data.windows.checkIn.isLive && (
          <div className="flex items-start gap-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
            <Hourglass className="h-4 w-4 mt-0.5 text-primary shrink-0" />
            <div>
              <p className="font-medium">Check-in is open</p>
              <p className="text-xs text-muted-foreground">
                Scan the QR code at the front of the room to mark yourself
                present.
              </p>
            </div>
          </div>
        )
      )}
    </motion.div>
  );
}

// ---- Helpers ----
function deriveStatus(
  data: EventDetails
): "live" | "upcoming" | "ended" | "cancelled" {
  if (data.status !== "active") return "cancelled";
  if (data.windows.checkIn.isLive) return "live";
  if (data.windows.checkIn.isUpcoming) return "upcoming";
  return "ended";
}

function StatusBadge({ status }: { status: ReturnType<typeof deriveStatus> }) {
  switch (status) {
    case "live":
      return (
        <Badge className="bg-emerald-600 text-white hover:bg-emerald-600/90">
          <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
          Live
        </Badge>
      );
    case "upcoming":
      return (
        <Badge
          variant="outline"
          className="border-amber-500/50 text-amber-700 dark:text-amber-400"
        >
          <Hourglass className="h-3 w-3" />
          Upcoming
        </Badge>
      );
    case "ended":
      return <Badge variant="secondary">Ended</Badge>;
    case "cancelled":
      return <Badge variant="destructive">Cancelled</Badge>;
  }
}

function WindowStatusPill({
  isLive,
  isUpcoming,
  isEnded,
}: {
  isLive: boolean;
  isUpcoming: boolean;
  isEnded: boolean;
}) {
  if (isLive)
    return (
      <Badge className="bg-emerald-600 text-white hover:bg-emerald-600/90">
        <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
        Open now
      </Badge>
    );
  if (isUpcoming)
    return (
      <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400">
        Not open yet
      </Badge>
    );
  if (isEnded) return <Badge variant="secondary">Closed</Badge>;
  return null;
}

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="mt-0.5 text-muted-foreground">{icon}</div>
      <div className="space-y-0.5 min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium break-words">{value}</p>
      </div>
    </div>
  );
}

function DetailsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-20" />
      </div>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading event details…
      </div>
    </div>
  );
}
