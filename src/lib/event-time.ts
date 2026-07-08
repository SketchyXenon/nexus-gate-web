// ====================================================================
// Nexus Gate — Event Time Window Helper
//
// Centralizes all time-window logic so every endpoint uses the same
// rules. An event's check-in window is determined by:
//
//   1. Explicit checkInOpensAt / checkInClosesAt (if set by organizer)
//   2. Defaults:
//      - Opens: 15 minutes before scheduledAt
//      - Closes: endsAt (if set) or scheduledAt + 2 hours
//
// This prevents events from being scannable forever when no end time
// is specified.
// ====================================================================

const DEFAULT_OPEN_OFFSET_MS = 15 * 60 * 1000; // 15 min before
const DEFAULT_CLOSE_OFFSET_MS = 2 * 60 * 60 * 1000; // 2 hours after

export interface EventTimeWindow {
  opensAt: Date;
  closesAt: Date;
  isLive: boolean;
  isUpcoming: boolean;
  isEnded: boolean;
}

export function getEventTimeWindow(event: {
  scheduledAt: Date;
  endsAt: Date | null;
  checkInOpensAt: Date | null;
  checkInClosesAt: Date | null;
  status: string;
}): EventTimeWindow {
  // Use explicit times if set, otherwise compute defaults
  const opensAt = event.checkInOpensAt
    ? new Date(event.checkInOpensAt)
    : new Date(new Date(event.scheduledAt).getTime() - DEFAULT_OPEN_OFFSET_MS);

  const closesAt = event.checkInClosesAt
    ? new Date(event.checkInClosesAt)
    : event.endsAt
      ? new Date(event.endsAt)
      : new Date(
          new Date(event.scheduledAt).getTime() + DEFAULT_CLOSE_OFFSET_MS,
        );

  const now = Date.now();
  const isLive =
    event.status === "active" &&
    now >= opensAt.getTime() &&
    now <= closesAt.getTime();
  const isUpcoming = event.status === "active" && now < opensAt.getTime();
  const isEnded = event.status !== "active" || now > closesAt.getTime();

  return { opensAt, closesAt, isLive, isUpcoming, isEnded };
}

export function getTimeStatus(event: {
  scheduledAt: Date;
  endsAt: Date | null;
  checkInOpensAt: Date | null;
  checkInClosesAt: Date | null;
  status: string;
}): "live" | "upcoming" | "ended" | "cancelled" {
  if (event.status !== "active") return "cancelled";
  const { isLive, isUpcoming } = getEventTimeWindow(event);
  if (isLive) return "live";
  if (isUpcoming) return "upcoming";
  return "ended";
}

// ====================================================================
// Plural variant — returns BOTH the check-in window and (if enabled)
// the time-out window. Used by /api/events/[id]/details to give the
// frontend a complete picture of an event's lifecycle.
//
// Time-out window is only computed when event.enableTimeOut === true.
// When explicit timeOutOpensAt/timeOutClosesAt are not set, defaults are:
//   - Opens: scheduledAt + 60 minutes (after class has started)
//   - Closes: endsAt (if set) or scheduledAt + 4 hours
//
// Safety: if explicit times violate ordering (opens >= closes), the
// defaults are used instead. This prevents a bad config from breaking
// the time-out window.
// ====================================================================
const DEFAULT_TIMEOUT_OPEN_OFFSET_MS = 60 * 60 * 1000; // 60 min after start
const DEFAULT_TIMEOUT_CLOSE_OFFSET_MS = 4 * 60 * 60 * 1000; // 4 hours after start

export interface EventTimeWindows {
  checkIn: EventTimeWindow;
  timeOut: EventTimeWindow | null;
}

export function getEventTimeWindows(event: {
  scheduledAt: Date;
  endsAt: Date | null;
  checkInOpensAt: Date | null;
  checkInClosesAt: Date | null;
  timeOutOpensAt: Date | null;
  timeOutClosesAt: Date | null;
  enableTimeOut: boolean;
  status: string;
}): EventTimeWindows {
  const checkIn = getEventTimeWindow(event);

  if (!event.enableTimeOut) {
    return { checkIn, timeOut: null };
  }

  // Compute default opens/closes.
  const defaultOpens = new Date(
    new Date(event.scheduledAt).getTime() + DEFAULT_TIMEOUT_OPEN_OFFSET_MS,
  );
  const defaultCloses = event.endsAt
    ? new Date(event.endsAt)
    : new Date(
        new Date(event.scheduledAt).getTime() + DEFAULT_TIMEOUT_CLOSE_OFFSET_MS,
      );

  // Use explicit times if set AND valid; otherwise fall back to defaults.
  const explicitOpens = event.timeOutOpensAt
    ? new Date(event.timeOutOpensAt)
    : null;
  const explicitCloses = event.timeOutClosesAt
    ? new Date(event.timeOutClosesAt)
    : null;

  // Safety: if explicit opens >= explicit closes, use defaults.
  let opensAt: Date;
  let closesAt: Date;
  if (explicitOpens && explicitCloses && explicitOpens < explicitCloses) {
    opensAt = explicitOpens;
    closesAt = explicitCloses;
  } else if (explicitOpens && !explicitCloses) {
    // Only opens set — use it, plus default close (or endsAt).
    opensAt = explicitOpens;
    closesAt =
      defaultCloses.getTime() > opensAt.getTime()
        ? defaultCloses
        : new Date(opensAt.getTime() + DEFAULT_TIMEOUT_CLOSE_OFFSET_MS);
  } else if (explicitCloses && !explicitOpens) {
    // Only closes set — use default opens if before closes.
    opensAt =
      defaultOpens.getTime() < explicitCloses.getTime()
        ? defaultOpens
        : new Date(explicitCloses.getTime() - DEFAULT_TIMEOUT_OPEN_OFFSET_MS);
    closesAt = explicitCloses;
  } else {
    opensAt = defaultOpens;
    closesAt = defaultCloses;
  }

  const now = Date.now();
  const isLive =
    event.status === "active" &&
    now >= opensAt.getTime() &&
    now <= closesAt.getTime();

  const isUpcoming = event.status === "active" && now < opensAt.getTime();
  const isEnded = event.status !== "active" || now > closesAt.getTime();

  return {
    checkIn,
    timeOut: { opensAt, closesAt, isLive, isUpcoming, isEnded },
  };
}
