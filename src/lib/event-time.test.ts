import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getEventTimeWindow,
  getEventTimeWindows,
  getTimeStatus,
} from "./event-time";

// ====================================================================
// Tests for event time-window logic.
// Covers: check-in defaults, explicit times, time-out window,
// boundary conditions, and the getTimeStatus integration.
// ====================================================================

const NOW = new Date("2026-07-10T10:00:00Z");
const ONE_HOUR = 60 * 60 * 1000;
const ONE_MIN = 60 * 1000;

beforeEach(() => {
  // Freeze the clock so getEventTimeWindow's internal Date.now() returns NOW.
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// Helper: create a base event with sensible defaults.
function makeEvent(overrides: Partial<{
  scheduledAt: Date;
  endsAt: Date | null;
  checkInOpensAt: Date | null;
  checkInClosesAt: Date | null;
  timeOutOpensAt: Date | null;
  timeOutClosesAt: Date | null;
  enableTimeOut: boolean;
  status: string;
}> = {}) {
  return {
    scheduledAt: new Date(NOW.getTime() + ONE_HOUR), // starts in 1h
    endsAt: null,
    checkInOpensAt: null,
    checkInClosesAt: null,
    timeOutOpensAt: null,
    timeOutClosesAt: null,
    enableTimeOut: false,
    status: "active",
    ...overrides,
  };
}

// ====================================================================
// getEventTimeWindow (singular — check-in only)
// ====================================================================

describe("getEventTimeWindow", () => {
  it("defaults: opens 15min before, closes 2h after scheduledAt", () => {
    const e = makeEvent();
    const w = getEventTimeWindow(e);
    // scheduledAt is NOW + 1h. Opens at NOW + 45min, closes at NOW + 3h.
    expect(w.opensAt.getTime()).toBe(NOW.getTime() + 45 * ONE_MIN);
    expect(w.closesAt.getTime()).toBe(NOW.getTime() + 3 * ONE_HOUR);
    expect(w.isUpcoming).toBe(true);
    expect(w.isLive).toBe(false);
    expect(w.isEnded).toBe(false);
  });

  it("is live when now is between opens and closes", () => {
    const e = makeEvent({
      scheduledAt: new Date(NOW.getTime() - 30 * ONE_MIN), // started 30min ago
    });
    const w = getEventTimeWindow(e);
    // Opens 45min ago, closes 1.5h from now.
    expect(w.isLive).toBe(true);
    expect(w.isUpcoming).toBe(false);
    expect(w.isEnded).toBe(false);
  });

  it("is ended when now is after closes", () => {
    const e = makeEvent({
      scheduledAt: new Date(NOW.getTime() - 3 * ONE_HOUR), // 3h ago
    });
    const w = getEventTimeWindow(e);
    expect(w.isEnded).toBe(true);
    expect(w.isLive).toBe(false);
  });

  it("respects explicit checkInOpensAt/checkInClosesAt", () => {
    const e = makeEvent({
      checkInOpensAt: new Date(NOW.getTime() - 10 * ONE_MIN),
      checkInClosesAt: new Date(NOW.getTime() + 10 * ONE_MIN),
    });
    const w = getEventTimeWindow(e);
    expect(w.isLive).toBe(true);
  });

  it("uses endsAt as default close when no checkInClosesAt", () => {
    const e = makeEvent({
      scheduledAt: new Date(NOW.getTime() - 30 * ONE_MIN),
      endsAt: new Date(NOW.getTime() + 30 * ONE_MIN),
    });
    const w = getEventTimeWindow(e);
    expect(w.closesAt.getTime()).toBe(NOW.getTime() + 30 * ONE_MIN);
    expect(w.isLive).toBe(true);
  });

  it("cancelled event is always ended", () => {
    const e = makeEvent({ status: "cancelled" });
    const w = getEventTimeWindow(e);
    expect(w.isEnded).toBe(true);
  });
});

// ====================================================================
// getEventTimeWindows (plural — check-in + time-out)
// ====================================================================

describe("getEventTimeWindows", () => {
  it("returns null timeOut when enableTimeOut is false", () => {
    const e = makeEvent({ enableTimeOut: false });
    const ws = getEventTimeWindows(e);
    expect(ws.timeOut).toBeNull();
    expect(ws.checkIn).toBeDefined();
  });

  it("computes default time-out window when enableTimeOut is true", () => {
    const e = makeEvent({
      enableTimeOut: true,
      scheduledAt: new Date(NOW.getTime() - 30 * ONE_MIN), // started 30min ago
    });
    const ws = getEventTimeWindows(e);
    expect(ws.timeOut).not.toBeNull();
    // Default opens: scheduledAt + 60min = NOW + 30min (upcoming)
    // Default closes: scheduledAt + 4h = NOW + 3.5h
    expect(ws.timeOut!.opensAt.getTime()).toBe(NOW.getTime() + 30 * ONE_MIN);
    expect(ws.timeOut!.isUpcoming).toBe(true);
  });

  it("time-out window is live when now is between timeOut opens and closes", () => {
    const e = makeEvent({
      enableTimeOut: true,
      scheduledAt: new Date(NOW.getTime() - 2 * ONE_HOUR - 30 * ONE_MIN), // 2.5h ago
    });
    const ws = getEventTimeWindows(e);
    // Check-in: opens 2h45m ago, closes 30min ago (ended)
    // Time-out: opens 1.5h ago, closes 1.5h from now (live)
    expect(ws.checkIn.isEnded).toBe(true);
    expect(ws.timeOut!.isLive).toBe(true);
  });

  it("respects explicit timeOutOpensAt/timeOutClosesAt", () => {
    const e = makeEvent({
      enableTimeOut: true,
      timeOutOpensAt: new Date(NOW.getTime() - 10 * ONE_MIN),
      timeOutClosesAt: new Date(NOW.getTime() + 10 * ONE_MIN),
    });
    const ws = getEventTimeWindows(e);
    expect(ws.timeOut!.isLive).toBe(true);
  });

  it("falls back to defaults when explicit opens >= closes (invalid)", () => {
    const e = makeEvent({
      enableTimeOut: true,
      scheduledAt: new Date(NOW.getTime() - 2 * ONE_HOUR),
      timeOutOpensAt: new Date(NOW.getTime() + ONE_HOUR), // after closes
      timeOutClosesAt: new Date(NOW.getTime() - ONE_HOUR), // before opens
    });
    const ws = getEventTimeWindows(e);
    // Should use defaults: opens = scheduledAt + 1h, closes = scheduledAt + 4h
    expect(ws.timeOut!.opensAt.getTime()).toBe(NOW.getTime() - ONE_HOUR);
    expect(ws.timeOut!.closesAt.getTime()).toBe(NOW.getTime() + 2 * ONE_HOUR);
  });

  it("both windows ended when time-out has passed", () => {
    const e = makeEvent({
      enableTimeOut: true,
      scheduledAt: new Date(NOW.getTime() - 5 * ONE_HOUR), // 5h ago
    });
    const ws = getEventTimeWindows(e);
    // Check-in: ended (3h ago close)
    // Time-out: ended (1h ago close)
    expect(ws.checkIn.isEnded).toBe(true);
    expect(ws.timeOut!.isEnded).toBe(true);
  });
});

// ====================================================================
// getTimeStatus — integration with time-out window
// ====================================================================

describe("getTimeStatus", () => {
  it("returns 'live' when check-in is live (time-out disabled)", () => {
    const e = makeEvent({
      scheduledAt: new Date(NOW.getTime() - 30 * ONE_MIN),
      enableTimeOut: false,
    });
    expect(getTimeStatus(e)).toBe("live");
  });

  it("returns 'ended' when check-in ended and time-out disabled", () => {
    const e = makeEvent({
      scheduledAt: new Date(NOW.getTime() - 3 * ONE_HOUR),
      enableTimeOut: false,
    });
    expect(getTimeStatus(e)).toBe("ended");
  });

  it("returns 'live' when check-in ended but time-out is live", () => {
    const e = makeEvent({
      enableTimeOut: true,
      scheduledAt: new Date(NOW.getTime() - 2 * ONE_HOUR - 30 * ONE_MIN), // 2.5h ago
    });
    // Check-in: ended (closed 30min ago)
    // Time-out: live (opened 1.5h ago, closes 1.5h from now)
    expect(getTimeStatus(e)).toBe("live");
  });

  it("returns 'ended' when BOTH check-in and time-out have ended", () => {
    const e = makeEvent({
      enableTimeOut: true,
      scheduledAt: new Date(NOW.getTime() - 5 * ONE_HOUR), // 5h ago
    });
    expect(getTimeStatus(e)).toBe("ended");
  });

  it("returns 'upcoming' when neither window has opened", () => {
    const e = makeEvent({
      enableTimeOut: true,
      scheduledAt: new Date(NOW.getTime() + ONE_HOUR), // 1h from now
    });
    expect(getTimeStatus(e)).toBe("upcoming");
  });

  it("returns 'cancelled' for non-active events", () => {
    const e = makeEvent({ status: "cancelled" });
    expect(getTimeStatus(e)).toBe("cancelled");
  });

  it("returns 'live' when time-out is upcoming but check-in is live", () => {
    const e = makeEvent({
      enableTimeOut: true,
      scheduledAt: new Date(NOW.getTime() - 30 * ONE_MIN), // 30min ago
    });
    // Check-in: live (opened 45min ago, closes 1.5h from now)
    // Time-out: upcoming (opens 30min from now)
    expect(getTimeStatus(e)).toBe("live");
  });
});
