// ====================================================================
// Nexus Gate — Validation Schemas (Zod)
// Every API input is validated server-side.
// ====================================================================

import { z } from "zod";
import { PROGRAM_CODES } from "./programs";
import { scorePassword, MIN_PASSWORD_SCORE } from "./password-strength";

// ---- Auth ----
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address")
  .max(255);

// Password schema — minimum standard: 8+ chars with uppercase, lowercase,
// number, and special character. Enforced server-side (cannot be bypassed).
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password is too long")
  .regex(/[A-Z]/, "Include at least one uppercase letter")
  .regex(/[a-z]/, "Include at least one lowercase letter")
  .regex(/[0-9]/, "Include at least one number")
  .regex(
    /[^A-Za-z0-9]/,
    "Include at least one special character (!@#$%^&*...)",
  );

// STRONG password schema — used by the CHANGE PASSWORD route.
// Runs the shared scorePassword() scorer on the SERVER and rejects
// any password scoring below MIN_PASSWORD_SCORE (4).
export const strongPasswordSchema = passwordSchema.refine(
  (pw) => scorePassword(pw).passes,
  {
    message: `Password is not strong enough. Use 12+ characters with a mix of uppercase, lowercase, numbers, and special characters.`,
  },
);

export const studentIdSchema = z
  .number()
  .int("Student ID must be a whole number")
  .min(1000000, "Student ID must be 7 digits")
  .max(9999999, "Student ID must be 7 digits");

export const studentIdStringSchema = z
  .string()
  .trim()
  .regex(/^\d{7}$/, "Student ID must be exactly 7 digits (e.g. 3240001)");

// ---- Full name schema (strict: no numbers) ----
export const fullNameSchema = z
  .string()
  .trim()
  .min(2, "Enter your full name (at least 2 characters)")
  .max(255, "Name is too long")
  .refine((val) => !/\d/.test(val), { message: "Names cannot contain numbers" })
  .refine((val) => /^[\p{L}\s\-'.]+$/u.test(val), {
    message: "Names can only contain letters, spaces, hyphens, and apostrophes",
  });

// ---- Program + section (optional at registration) ----
export const programSchema = z
  .string()
  .trim()
  .max(10, "Program code is too long")
  .refine((val) => val === "" || PROGRAM_CODES.has(val), {
    message: "Select a valid program from the list",
  })
  .optional()
  .nullable()
  .transform((val) => (val === "" ? null : val));

// ---- Section schema (STRICT: must be "<number>-<letter>" format) ----
// Examples: "1-A", "2-B", "3-C" — valid
// "2", "A", "2A", "2-A-B" — INVALID (must have exactly one number, a hyphen, and one letter)
// The number and letter can be multi-char (e.g. "10-AB") but must follow
// the <digits>-<letters> pattern.
export const sectionSchema = z
  .string()
  .trim()
  .max(10, "Section is too long")
  .regex(
    /^\d+-[A-Za-z]+$/,
    "Section must be in the format '<year>-<letter>' (e.g. '2-A', '3-B')",
  )
  .optional()
  .nullable()
  .or(z.literal("").transform(() => null));

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: fullNameSchema,
  studentId: studentIdSchema,
  program: programSchema,
  section: sectionSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password").max(128),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

// ---- Password reset ----
// Email-only schema for the forgot-password request. The reset endpoint
// accepts a token + new password.
export const forgotPasswordSchema = z.object({
  email: emailSchema,
  redirectTo: z.string().trim().url().optional(),
});

export const resetPasswordSchema = z.object({
  token: z.string().optional(),
  password: passwordSchema,
});

// ---- Whitelist ----
export const whitelistRowSchema = z.object({
  studentId: studentIdSchema,
  email: emailSchema,
  fullName: z.string().trim().min(2).max(255),
  program: z.string().trim().min(1).max(50),
  section: z
    .string()
    .trim()
    .min(1)
    .max(10)
    .regex(
      /^\d+-[A-Za-z]+$/,
      "Section must be in the format '<year>-<letter>' (e.g. '2-A', '3-B')",
    ),
});

export const importWhitelistSchema = z.object({
  students: z.array(whitelistRowSchema).min(1).max(5000),
});

// ---- Events ----
// Base event schema (no refinements so .partial() works)
const eventBaseSchema = z.object({
  title: z.string().trim().min(1, "Enter an event title").max(255),
  description: z.string().trim().max(2000).optional(),
  scope: z.enum(["academic", "departmental"]).default("academic"),
  targetProgram: z.string().trim().max(50).optional().nullable(),
  targetSection: z.string().trim().max(10).optional().nullable(),
  scheduledAt: z.string().datetime(),
  endsAt: z.string().datetime().optional().nullable(),
  checkInOpensAt: z.string().datetime().optional().nullable(),
  checkInClosesAt: z.string().datetime().optional().nullable(),
  // Time-out feature: when enabled, students can scan to time out after class.
  enableTimeOut: z.boolean().optional(),
  timeOutOpensAt: z.string().datetime().optional().nullable(),
  timeOutClosesAt: z.string().datetime().optional().nullable(),
  // QR delegation: when true, other organizers in the same program can
  // project this event's QR code (GET /api/events/[id]/secret).
  delegatable: z.boolean().optional(),
  // Admin-controlled: when true, allows other organizers to project this
  // event's QR code if they share the same organizationName tag (or if
  // the event is open-to-all). Default: false.
  delegationEnabled: z.boolean().optional(),
});

export const createEventSchema = eventBaseSchema
  .refine(
    (data) => {
      if (data.checkInOpensAt && data.checkInClosesAt) {
        return new Date(data.checkInOpensAt) < new Date(data.checkInClosesAt);
      }
      return true;
    },
    { message: "Check-in open time must be before close time" },
  )
  .refine(
    (data) => {
      if (data.endsAt) {
        return new Date(data.endsAt) > new Date(data.scheduledAt);
      }
      return true;
    },
    { message: "End time must be after the scheduled time" },
  );

export const updateEventSchema = eventBaseSchema.partial();

// ---- Attendance (v8 — signed scan certificate) ----
// The scan endpoint accepts a SIGNED scan certificate instead of a raw
// token. The certificate is cryptographically bound to the device and
// includes the token + sub-frame captures (index + client-observed HMAC)
// + timestamp + nonce.
export const scanCertificateSchema = z.object({
  certificate: z.object({
    eventId: z.number().int().positive(),
    token: z.string().trim().min(1, "Token is required").max(500),
    scannedAt: z.number().int().positive(),
    nonce: z.string().min(16).max(128),
    deviceFingerprint: z.string().min(32).max(128),
    // Each sub-frame must include its client-observed HMAC (64 hex chars)
    subFrames: z
      .array(
        z.object({
          subFrame: z.number().int().min(0).max(29),
          hmac: z.string().length(64),
        }),
      )
      .min(3)
      .max(30),
  }),
  canonical: z.string().min(1),
  signature: z.string().min(1),
});

// Legacy scan schema (for backward compatibility — not used by new clients)
export const scanSchema = z.object({
  eventId: z.number().int().positive(),
  token: z.string().trim().min(1, "Token is required").max(500),
});

export const overrideSchema = z.object({
  eventId: z.number().int().positive(),
  studentId: studentIdSchema,
  reason: z.string().trim().min(1).max(500).default("Missing or broken device"),
});

// ---- Accounts ----
// Admin can edit any field on any account. Program/section/year/organizationName
// are optional and only persisted when provided (PATCH semantics).
export const updateAccountSchema = z.object({
  role: z.enum(["ADMIN", "ORGANIZER", "USER"]).optional(),
  status: z.enum(["PENDING_VERIFICATION", "ACTIVE", "SUSPENDED"]).optional(),
  fullName: fullNameSchema.optional(),
  email: emailSchema.optional(),
  program: z.string().trim().max(50).optional().nullable(),
  section: z
    .string()
    .trim()
    .max(10)
    .regex(/^\d+-[A-Za-z]+$/, "Section must be '<year>-<letter>' (e.g. '2-A')")
    .optional()
    .nullable(),
  year: z.number().int().min(1).max(6).optional().nullable(),
  organizationName: z.string().trim().max(255).optional().nullable(),
});

// Admin creates an account (for organizer/admin roles)
export const adminCreateAccountSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: fullNameSchema,
  role: z.enum(["ADMIN", "ORGANIZER"]),
  program: z.string().trim().max(50).optional().nullable(),
  section: z
    .string()
    .trim()
    .max(10)
    .regex(/^\d+-[A-Za-z]+$/, "Section must be '<year>-<letter>' (e.g. '2-A')")
    .optional()
    .nullable(),
  organizationName: z.string().trim().max(255).optional().nullable(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).default("ACTIVE"),
});

// Self-update profile (users + organizers)
// Users can change: fullName, year, section, and course (course only once)
// Organizers can change: fullName only
// Program must be a valid code from the programs list (enforced server-side).
// Full name uses the SAME strict schema as registration (no numbers, letters only).
export const updateProfileSchema = z.object({
  fullName: fullNameSchema,
  // Student-only fields (ignored for organizers)
  program: z
    .string()
    .trim()
    .max(50)
    .refine((val) => val === "" || PROGRAM_CODES.has(val), {
      message: "Select a valid program from the list",
    })
    .optional(),
  year: z.number().int().min(1).max(6).optional(),
  section: z
    .string()
    .trim()
    .max(10)
    .regex(/^\d+-[A-Za-z]+$/, "Section must be '<year>-<letter>' (e.g. '2-A')")
    .optional(),
});

// Change password (self-service)
// Uses the STRONG password schema so the new password must score
// at least MIN_PASSWORD_SCORE (4) on the server-side scorer.
// This prevents users from setting a weak password even if they
// modify the client to bypass the meter.
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
  newPassword: strongPasswordSchema,
});

// ---- Pagination ----
// Default pagination schema — caps pageSize at 100 to prevent abuse on
// list endpoints (accounts, audit-logs, overrides, etc.).
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

// Whitelist pagination schema — allows up to 500 per page. The override
// page needs to fetch all eligible students for an event in one request
// (to populate the student dropdown). Department-wide events can have
// hundreds of students, so the default 100 cap is too low and causes
// a 400 Bad Request when the client requests pageSize=200.
export const whitelistPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ScanInput = z.infer<typeof scanSchema>;
export type CreateEventInput = z.infer<typeof createEventSchema>;
