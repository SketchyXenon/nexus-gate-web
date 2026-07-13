// ====================================================================
// Nexus Gate — Frontend API client + React Query hooks
// ====================================================================

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export type Role = "ADMIN" | "ORGANIZER" | "USER";

export interface Account {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  status: "PENDING_VERIFICATION" | "ACTIVE" | "SUSPENDED";
  studentId: number | null;
  program: string | null;
  section: string | null;
  year?: number | null;
  organizationName?: string | null;
  courseModifiedAt?: string | null;
  lastProfileUpdateAt?: string | null;
  lastLoginAt?: string | null;
  createdAt?: string;
}

export interface Profile extends Account {
  canUpdateProfile: boolean;
  daysUntilProfileUpdate: number;
  canChangeCourse: boolean;
  canChangePassword: boolean;
  daysUntilPasswordChange: number;
}

export interface AuthorizedStudent {
  studentId: number;
  email: string;
  fullName: string;
  program: string;
  section: string;
  activated: boolean;
  account?: { id: string; status: string; role: string } | null;
}

export interface EventItem {
  id: number;
  title: string;
  description?: string | null;
  scope: "academic" | "departmental";
  targetProgram: string | null;
  targetSection: string | null;
  scheduledAt: string;
  endsAt?: string | null;
  status: string;
  ownerId: string;
  owner?: { fullName: string } | null;
  _count?: { attendances: number };
  presentCount?: number;
  timeStatus?: "live" | "upcoming" | "ended" | "cancelled";
  delegatable?: boolean;
  delegationEnabled?: boolean;
  // Timing-window fields (returned by the server but historically absent
  // from this interface — declared here so consumers can render check-in /
  // time-out windows without resorting to `any`).
  checkInOpensAt?: string | null;
  checkInClosesAt?: string | null;
  timeOutOpensAt?: string | null;
  timeOutClosesAt?: string | null;
  enableTimeOut?: boolean;
}

export interface AttendanceRow {
  id: number;
  eventId: number;
  accountId: string;
  scannedAt: string;
  timeOutAt: string | null;
  source: string;
  account: {
    id: string;
    fullName: string;
    studentId: number | null;
    program: string | null;
    section: string | null;
  };
}

// ---- Token refresh state (prevents multiple simultaneous refresh calls) ----
let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (isRefreshing && refreshPromise) return refreshPromise;
  isRefreshing = true;
  refreshPromise = (async () => {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      isRefreshing = false;
    }
  })();
  return refreshPromise;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    credentials: "include",
  });

  // ---- Auto-refresh on 401: try to refresh the session, then retry once ----
  if (res.status === 401 && !url.includes("/api/auth/")) {
    const refreshed = await refreshSession();
    if (refreshed) {
      // Retry the original request with the new cookie
      const retryRes = await fetch(url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(init?.headers || {}),
        },
        credentials: "include",
      });
      if (retryRes.ok) {
        if (retryRes.status === 204) return undefined as T;
        return retryRes.json() as Promise<T>;
      }
    }
    // Refresh failed — the user will be redirected to login by useMe()
  }

  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    let body: Record<string, unknown> | null = null;
    try {
      body = await res.json();
      if (body) {
        msg = (body.error as string) || (body.message as string) || msg;
      }
    } catch {
      /* ignore */
    }
    const err = new Error(msg) as Error & {
      status?: number;
      code?: string;
      data?: Record<string, unknown> | null;
    };
    err.status = res.status;
    if (body) {
      err.code = body.code as string | undefined;
      err.data = body;
    }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---------------- Auth ----------------
export const useMe = () =>
  useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      return await api<Account>("/api/auth/me");
    },
    retry: false,
    staleTime: 60_000,
  });

export const useLogin = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { email: string; password: string }) =>
      api<Account>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
};

export const useRegister = () =>
  useMutation({
    mutationFn: (vars: {
      email: string;
      password: string;
      fullName: string;
      studentId: number;
      program?: string;
      section?: string;
    }) =>
      api<{
        ok: boolean;
        email: string;
        message: string;
        whitelisted?: boolean;
        needsEmailConfirmation?: boolean;
      }>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
  });

export const useForgotPassword = () =>
  useMutation({
    mutationFn: (vars: { email: string; redirectTo?: string }) =>
      api<{ ok: boolean; message: string }>("/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
  });

export const useResetPassword = () =>
  useMutation({
    mutationFn: (vars: { password: string }) =>
      api<{ ok: boolean; message: string }>("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
  });

// Pre-registration availability check for email and/or student ID.
// Debounced 400ms via enabled flag — only fires when inputs are format-valid.
export const useCheckAvailability = (
  email: string | null,
  studentId: string | null,
) =>
  useQuery({
    queryKey: ["auth-check", email, studentId],
    queryFn: () =>
      api<{ emailTaken?: boolean; studentIdTaken?: boolean }>(
        "/api/auth/check",
        {
          method: "POST",
          body: JSON.stringify({
            ...(email ? { email } : {}),
            ...(studentId ? { studentId } : {}),
          }),
        },
      ),
    enabled: Boolean(email || studentId),
    staleTime: 30_000,
    retry: false,
  });

export const useLogout = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
      // Also sign out of the Supabase browser client to clear local state.
      try {
        const { createSupabaseBrowserClient } =
          await import("@/lib/supabase-browser");
        await createSupabaseBrowserClient().auth.signOut();
      } catch {
        // Non-critical - the server-side signOut already cleared the cookie.
      }
    },
    onSuccess: () => {
      qc.setQueryData(["me"], null);
      qc.clear();
    },
  });
};

// ---------------- Whitelist ----------------
export type WhitelistSort = "name" | "studentId" | "program";
export const useWhitelist = (params?: {
  page?: number;
  pageSize?: number;
  program?: string;
  section?: string;
  q?: string;
  sort?: WhitelistSort;
  enabled?: boolean;
}) => {
  const sp = new URLSearchParams();
  if (params?.page) sp.set("page", String(params.page));
  if (params?.pageSize) sp.set("pageSize", String(params.pageSize));
  if (params?.program) sp.set("program", params.program);
  if (params?.section) sp.set("section", params.section);
  if (params?.q) sp.set("q", params.q);
  if (params?.sort) sp.set("sort", params.sort);
  return useQuery({
    queryKey: ["whitelist", params],
    queryFn: () =>
      api<{
        students: AuthorizedStudent[];
        pagination: {
          page: number;
          pageSize: number;
          total: number;
          totalPages: number;
        };
      }>(`/api/whitelist?${sp}`),
    // Only fetch when explicitly enabled (prevents fetching ALL students
    // before an event is selected on the override page).
    enabled: params?.enabled !== false,
    // Keep previous data while refetching (smoother UX when switching events).
    placeholderData: (prev) => prev,
  });
};

export const useImportWhitelist = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      students: Array<{
        studentId: number;
        email: string;
        fullName: string;
        program: string;
        section: string;
      }>,
    ) =>
      api<{ inserted: number; skipped: number; total: number }>(
        "/api/whitelist",
        { method: "POST", body: JSON.stringify({ students }) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whitelist"] }),
  });
};

export const useDeleteWhitelist = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (studentId: number) =>
      api<{ ok: boolean }>(`/api/whitelist/${studentId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whitelist"] }),
  });
};

// ---------------- Events ----------------
export interface EventsResponse {
  events: EventItem[];
  needsProfile?: boolean;
  userProgram?: string | null;
  userSection?: string | null;
}

export type EventStatusFilter = "active" | "upcoming" | "ended" | "all";
export type EventSort = "newest" | "oldest";

export interface EventsListParams {
  scope?: "academic" | "departmental";
  /** Server-side title search (debounced on the client, 300 ms). */
  q?: string;
  /** Filter by computed time status. "ended"/"all" implicitly enable includeEnded. */
  status?: EventStatusFilter;
  /** Sort by scheduledAt. Defaults to "newest" (desc). */
  sort?: EventSort;
  /** Also include ended events in the response. */
  includeEnded?: boolean;
}

export const useEvents = (params?: EventsListParams) => {
  const sp = new URLSearchParams();
  if (params?.scope) sp.set("scope", params.scope);
  if (params?.q) sp.set("q", params.q);
  if (params?.status) sp.set("status", params.status);
  if (params?.sort) sp.set("sort", params.sort);
  if (params?.includeEnded) sp.set("includeEnded", "true");
  return useQuery({
    queryKey: ["events", params],
    queryFn: () => api<EventsResponse>(`/api/events?${sp}`),
  });
};

export const useEventSecret = (id: number | null) =>
  useQuery({
    queryKey: ["event-secret", id],
    queryFn: () =>
      api<{
        id: number;
        title: string;
        eventSecret: string;
        scheduledAt: string;
        targetProgram: string | null;
        targetSection: string | null;
        scope: string;
        isDelegated: boolean;
        delegatable: boolean;
        isCheckInLive?: boolean;
        isTimeOutLive?: boolean;
        enableTimeOut?: boolean;
      }>(`/api/events/${id}/secret`),
    enabled: id != null,
    staleTime: 5 * 60_000,
    // Poll every 15s when the error is UPCOMING (the check-in window
    // hasn't opened yet — auto-refresh when it opens). Don't poll for
    // FORBIDDEN errors (the user doesn't have permission — retrying
    // just spams the server with 403s).
    refetchInterval: (query) => {
      const err = query.state.error as { code?: string } | undefined;
      if (err?.code === "UPCOMING") {
        return 15_000;
      }
      return false;
    },
    // Don't retry FORBIDDEN errors — retrying just spams 403s.
    retry: (failureCount, error) => {
      const err = error as { code?: string; status?: number } | undefined;
      if (err?.code === "FORBIDDEN" || err?.status === 403) return false;
      return failureCount < 2;
    },
  });

export const useCreateEvent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      title: string;
      scheduledAt: string;
      description?: string;
      scope?: "academic" | "departmental";
      targetProgram?: string;
      targetSection?: string;
      endsAt?: string;
      checkInOpensAt?: string;
      checkInClosesAt?: string;
      timeOutOpensAt?: string;
      timeOutClosesAt?: string;
      enableTimeOut?: boolean;
      delegatable?: boolean;
      delegationEnabled?: boolean;
    }) =>
      api<EventItem>("/api/events", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["events"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
};

export const useDeleteEvent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; hard?: boolean }) =>
      api<{ ok: boolean; deleted?: boolean }>(
        `/api/events/${vars.id}${vars.hard ? "?hard=true" : ""}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["events"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
};

// Fetch events including ended ones (for history/archive)
export const useEventsHistory = (scope?: string) => {
  const sp = new URLSearchParams();
  if (scope) sp.set("scope", scope);
  sp.set("includeEnded", "true");
  return useQuery({
    queryKey: ["events-history", scope],
    queryFn: () => api<{ events: EventItem[] }>(`/api/events?${sp}`),
  });
};

// ---------------- Attendance ----------------
export const useEventAttendance = (
  eventId: number | null,
  options?: { poll?: boolean; socketConnected?: boolean },
) =>
  useQuery({
    queryKey: ["attendance", eventId],
    queryFn: () =>
      api<{
        event: EventItem;
        presentCount: number;
        eligibleCount: number;
        attendances: AttendanceRow[];
      }>(`/api/events/${eventId}/attendance`),
    enabled: eventId != null,
    // Polling strategy:
    //   - Override page: poll=false (no polling)
    //   - Socket connected: no polling (Ably pushes realtime updates)
    //   - Socket disconnected: poll every 15s as fallback (was 4s, then 10s)
    refetchInterval:
      eventId != null && options?.poll !== false && !options?.socketConnected
        ? 15_000
        : false,
  });

// Recent attendance records across all events (admin/organizer dashboard).
export interface RecentAttendanceRecord {
  id: number;
  scannedAt: string;
  source: string;
  event: {
    id: number;
    title: string;
    scheduledAt: string;
    targetProgram: string | null;
    targetSection: string | null;
  };
  account: {
    id: string;
    fullName: string;
    studentId: number | null;
    program: string | null;
    section: string | null;
  };
}

export const useRecentAttendance = (limit = 20) =>
  useQuery({
    queryKey: ["recent-attendance", limit],
    queryFn: () =>
      api<{ records: RecentAttendanceRecord[] }>(
        `/api/attendance/recent?limit=${limit}`,
      ),
    staleTime: 30_000,
  });

// ---------------- Dashboard Stats (charts) ----------------
export interface DashboardStats {
  scansByDay: Array<{ date: string; count: number }>;
  topEvents: Array<{
    id: number;
    title: string;
    scheduledAt: string;
    presentCount: number;
  }>;
  scansBySource: { qr: number; override: number };
  scansByHour: Array<{ hour: number; count: number }>;
}

export const useDashboardStats = () =>
  useQuery({
    queryKey: ["dashboard-stats"],
    queryFn: () => api<DashboardStats>("/api/dashboard/stats"),
    staleTime: 60_000,
  });

// ---------------- CSV Export ----------------
// Triggers a browser download of the attendance CSV for an event.
export function exportAttendanceCsv(eventId: number): void {
  const url = `/api/attendance/export?eventId=${eventId}`;
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export interface EventDetails {
  id: number;
  title: string;
  description: string | null;
  scope: string;
  targetProgram: string | null;
  targetProgramLabel: string | null;
  targetSection: string | null;
  scheduledAt: string;
  endsAt: string | null;
  enableTimeOut: boolean;
  status: string;
  attendanceCount: number;
  myAttendance: {
    id: number;
    scannedAt: string;
    timeOutAt: string | null;
    source: string;
  } | null;
  windows: {
    checkIn: {
      opensAt: string;
      closesAt: string;
      isLive: boolean;
      isUpcoming: boolean;
      isEnded: boolean;
    };
    timeOut: { opensAt: string; closesAt: string; isLive: boolean } | null;
  };
}

export const useEventDetails = (eventId: number | null) =>
  useQuery({
    queryKey: ["event-details", eventId],
    queryFn: () => api<EventDetails>(`/api/events/${eventId}/details`),
    enabled: eventId != null,
  });

// v8: Submit a SIGNED scan certificate (replaces submitScanRaw)
export async function submitScanCertificate(signed: {
  certificate: {
    eventId: number;
    token: string;
    scannedAt: number;
    nonce: string;
    deviceFingerprint: string;
    subFrames: Array<{ subFrame: number; hmac: string }>;
  };
  canonical: string;
  signature: string;
}) {
  return api<{
    ok: boolean;
    action?: "time_in" | "already_scanned";
    alreadyPresent?: boolean;
    attendance?: AttendanceRow;
    message?: string;
    scannedAt?: string;
  }>("/api/attendance", {
    method: "POST",
    body: JSON.stringify(signed),
  });
}

export const useCreateOverride = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      eventId: number;
      studentId: number;
      reason?: string;
    }) =>
      api<{ ok: boolean }>("/api/attendance/override", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attendance"] });
      qc.invalidateQueries({ queryKey: ["overrides"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
};

// ---------------- Overrides list (cross-event) ----------------
export interface OverrideRow {
  id: number;
  eventId: number;
  studentId: number;
  reason: string;
  createdAt: string;
  event: {
    id: number;
    title: string;
    scheduledAt: string;
    targetProgram: string | null;
    targetSection: string | null;
  };
  student: {
    studentId: number;
    fullName: string;
    program: string;
    section: string;
    email: string;
  };
  admin: { id: string; fullName: string; email: string } | null;
}

export interface OverrideListParams {
  page?: number;
  pageSize?: number;
  eventId?: number;
  q?: string;
  from?: string; // ISO date string
  to?: string; // ISO date string
}

export const useOverrides = (params?: OverrideListParams) => {
  const sp = new URLSearchParams();
  if (params?.page) sp.set("page", String(params.page));
  if (params?.pageSize) sp.set("pageSize", String(params.pageSize));
  if (params?.eventId != null) sp.set("eventId", String(params.eventId));
  if (params?.q) sp.set("q", params.q);
  if (params?.from) sp.set("from", params.from);
  if (params?.to) sp.set("to", params.to);
  return useQuery({
    queryKey: ["overrides", params],
    queryFn: () =>
      api<{
        overrides: OverrideRow[];
        pagination: {
          page: number;
          pageSize: number;
          total: number;
          totalPages: number;
        };
      }>(`/api/attendance/overrides?${sp}`),
    staleTime: 5_000,
  });
};

// ---------------- Accounts ----------------
export const useAccounts = (params?: {
  role?: string;
  q?: string;
  page?: number;
}) => {
  const sp = new URLSearchParams();
  if (params?.role) sp.set("role", params.role);
  if (params?.q) sp.set("q", params.q);
  if (params?.page) sp.set("page", String(params.page));
  return useQuery({
    queryKey: ["accounts", params],
    queryFn: () =>
      api<{
        accounts: Account[];
        pagination: {
          page: number;
          pageSize: number;
          total: number;
          totalPages: number;
        };
      }>(`/api/accounts?${sp}`),
  });
};

export const useUpdateAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      role?: Role;
      status?: string;
      fullName?: string;
      email?: string;
      program?: string | null;
      section?: string | null;
      year?: number | null;
      organizationName?: string | null;
    }) => {
      // Only include fields that are explicitly provided — PATCH semantics.
      const body: Record<string, unknown> = {};
      if (vars.role !== undefined) body.role = vars.role;
      if (vars.status !== undefined) body.status = vars.status;
      if (vars.fullName !== undefined) body.fullName = vars.fullName;
      if (vars.email !== undefined) body.email = vars.email;
      if (vars.program !== undefined) body.program = vars.program;
      if (vars.section !== undefined) body.section = vars.section;
      if (vars.year !== undefined) body.year = vars.year;
      if (vars.organizationName !== undefined)
        body.organizationName = vars.organizationName;
      return api<Account>(`/api/accounts/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
};

// ---------------- Dashboard ----------------
export const useDashboard = () =>
  useQuery({
    queryKey: ["dashboard"],
    queryFn: () =>
      api<{
        user: Account;
        stats: {
          totalStudents?: number;
          totalEvents?: number;
          totalScans?: number;
          totalOverrides?: number;
          totalAttended?: number;
          eligibleEvents?: number;
        };
        recentEvents?: Array<
          EventItem & { presentCount: number; owner: string }
        >;
        attendances?: Array<
          AttendanceRow & {
            event: {
              id: number;
              title: string;
              scheduledAt: string;
              scope: string;
            };
          }
        >;
        programCounts?: Record<string, number>;
        sectionCounts?: Record<string, number>;
        needsProfile?: boolean;
      }>("/api/dashboard"),
    staleTime: 30_000,
  });

// ---------------- Student attendance history ----------------
export interface MyAttendanceRecord {
  id: number;
  scannedAt: string;
  timeOutAt: string | null;
  source: string;
  event: {
    id: number;
    title: string;
    scheduledAt: string;
    scope: string;
    targetProgram: string | null;
    targetSection: string | null;
  };
}

export interface MyAttendanceResponse {
  records: MyAttendanceRecord[];
  stats: {
    total: number;
    qrCount: number;
    overrideCount: number;
    withTimeout: number;
  };
}

export const useMyAttendance = (params?: {
  from?: string;
  to?: string;
  scope?: string;
}) => {
  const sp = new URLSearchParams();
  if (params?.from) sp.set("from", params.from);
  if (params?.to) sp.set("to", params.to);
  if (params?.scope) sp.set("scope", params.scope);
  const qs = sp.toString();
  return useQuery({
    queryKey: ["my-attendance", params],
    queryFn: () =>
      api<MyAttendanceResponse>(`/api/profile/attendance${qs ? `?${qs}` : ""}`),
    staleTime: 30_000,
  });
};

// ---------------- Student attendance stats (trends chart) ----------------
export interface MyStats {
  scansByMonth: Array<{ month: string; count: number }>;
  byScope: { academic: number; departmental: number };
  streak: { current: number; longest: number };
}

export const useMyStats = () =>
  useQuery({
    queryKey: ["my-stats"],
    queryFn: () => api<MyStats>("/api/profile/stats"),
    staleTime: 60_000,
  });

// ---------------- Notification preferences ----------------
export interface NotificationPrefs {
  eventReminders: boolean;
  attendanceSummary: boolean;
  accountSecurity: boolean;
}

export const useNotificationPrefs = () =>
  useQuery({
    queryKey: ["notification-prefs"],
    queryFn: () =>
      api<{ prefs: NotificationPrefs }>("/api/profile/notification-prefs"),
    staleTime: 60_000,
  });

export const useUpdateNotificationPrefs = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (prefs: NotificationPrefs) =>
      api<{ ok: boolean; prefs: NotificationPrefs }>(
        "/api/profile/notification-prefs",
        { method: "PATCH", body: JSON.stringify(prefs) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notification-prefs"] });
    },
  });
};

// ---------------- Audit logs ----------------
export const useAuditLogs = (params?: { page?: number; action?: string }) => {
  const sp = new URLSearchParams();
  if (params?.page) sp.set("page", String(params.page));
  if (params?.action) sp.set("action", params.action);
  return useQuery({
    queryKey: ["audit-logs", params],
    queryFn: () =>
      api<{
        logs: Array<{
          id: number;
          actorId: string | null;
          action: string;
          targetType: string | null;
          targetId: string | null;
          metadata: string | null;
          ipAddress: string | null;
          createdAt: string;
          actor?: { fullName: string; email: string } | null;
        }>;
        pagination: {
          page: number;
          pageSize: number;
          total: number;
          totalPages: number;
        };
      }>(`/api/audit-logs?${sp}`),
  });
};

// ---------------- Admin: Create Account ----------------
export const useAdminCreateAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      email: string;
      password: string;
      fullName: string;
      role: "ADMIN" | "ORGANIZER";
      program?: string;
      section?: string;
      organizationName?: string;
    }) =>
      api<Account>("/api/accounts/create", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
};

// ---------------- Admin: Delete Account ----------------
export const useDeleteAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; deleted: boolean }>(`/api/accounts/${id}/delete`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
};

// ---------------- Profile ----------------
export const useProfile = () =>
  useQuery({
    queryKey: ["profile"],
    queryFn: () => api<Profile>("/api/profile"),
  });

export const useUpdateProfile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      fullName: string;
      program?: string;
      year?: number;
      section?: string;
    }) =>
      api<Profile>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
};

export const useChangePassword = () =>
  useMutation({
    mutationFn: (vars: { currentPassword: string; newPassword: string }) =>
      api<{ ok: boolean; message: string }>("/api/profile/password", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
  });

// ---------------- Device Keys (self-service management) ----------------
export interface DeviceKeyItem {
  id: string;
  fingerprint: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const useDeviceKeys = () =>
  useQuery({
    queryKey: ["device-keys"],
    queryFn: () =>
      api<{ deviceKeys: DeviceKeyItem[] }>("/api/profile/device-key"),
    staleTime: 30_000,
  });

export const useRevokeDeviceKey = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      api<{ ok: boolean }>(
        `/api/profile/device-key?keyId=${encodeURIComponent(keyId)}`,
        {
          method: "DELETE",
        },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["device-keys"] }),
  });
};

// ---------------- Notifications ----------------
export interface NotificationItem {
  id: number;
  title: string;
  body: string;
  type: string;
  readAt: string | null;
  createdAt: string;
}

export const useNotifications = (unreadOnly?: boolean) =>
  useQuery({
    queryKey: ["notifications", unreadOnly],
    queryFn: () =>
      api<{ notifications: NotificationItem[]; unreadCount: number }>(
        `/api/notifications${unreadOnly ? "?unread=true" : ""}`,
      ),
    refetchInterval: 60_000, // poll every 60 seconds (reduced from 30s for scale)
  });

export const useMarkNotificationsRead = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (notificationId?: number) =>
      api<{ ok: boolean }>("/api/notifications", {
        method: "POST",
        body: JSON.stringify(notificationId ? { notificationId } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
};

export const useNotificationStatus = () =>
  useQuery({
    queryKey: ["notification-status"],
    queryFn: () =>
      api<{ enabled: boolean; hasSubscription: boolean }>(
        "/api/notifications/status",
      ),
  });

export const useSubscribeNotifications = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    }) =>
      api<{ ok: boolean }>("/api/notifications/subscribe", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["notification-status"] }),
  });
};

export const useUnsubscribeNotifications = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ ok: boolean }>("/api/notifications/subscribe", {
        method: "DELETE",
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["notification-status"] }),
  });
};
