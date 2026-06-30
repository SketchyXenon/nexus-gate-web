// ====================================================================
// Nexus Gate — Role-Based Access Control (RBAC)
// Three roles: ADMIN, ORGANIZER, USER
// Principle of Least Privilege: each route declares the minimum role.
// ====================================================================

export type Role = "ADMIN" | "ORGANIZER" | "USER";
export type AccountStatus = "PENDING_VERIFICATION" | "ACTIVE" | "SUSPENDED";

export const ROLE_HIERARCHY: Record<Role, number> = {
  USER: 1,
  ORGANIZER: 2,
  ADMIN: 3,
};

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrator",
  ORGANIZER: "Organizer",
  USER: "Student",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  ADMIN:
    "Full system control: manage accounts, whitelist, audit logs, all events.",
  ORGANIZER:
    "Create and manage your own events, project QR tokens, view attendance, record overrides.",
  USER:
    "Scan QR tokens to check in to events. View your own attendance history.",
};

// Permission matrix — PoLP: each action maps to the minimum role required.
export const PERMISSIONS = {
  // Account management
  "account.list": "ADMIN",
  "account.update_role": "ADMIN",
  "account.suspend": "ADMIN",
  "account.view_audit_logs": "ADMIN",
  // Whitelist — organizers can add students to their own program/section
  "whitelist.list": "ORGANIZER",
  "whitelist.import": "ORGANIZER",
  "whitelist.delete": "ADMIN",
  // Events
  "event.create": "ORGANIZER",
  "event.update_any": "ADMIN",
  "event.update_own": "ORGANIZER",
  "event.delete_any": "ADMIN",
  "event.delete_own": "ORGANIZER",
  "event.view_secret_own": "ORGANIZER",
  "event.view_secret_any": "ADMIN",
  // Attendance
  "attendance.scan": "USER",
  "attendance.view_own": "USER",
  "attendance.view_event_own": "ORGANIZER",
  "attendance.view_event_any": "ADMIN",
  "attendance.override_own": "ORGANIZER",
  "attendance.override_any": "ADMIN",
  "attendance.export": "ORGANIZER",
  // Dashboard
  "dashboard.view": "USER",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(role: Role | null, permission: Permission): boolean {
  if (!role) return false;
  const required = PERMISSIONS[permission];
  return ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[required];
}

export function hasMinimumRole(role: Role | null, minimum: Role): boolean {
  if (!role) return false;
  return ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[minimum];
}
