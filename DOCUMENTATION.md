# Nexus Gate — Full Documentation

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Authentication & Authorization](#3-authentication--authorization)
4. [QR Attendance System](#4-qr-attendance-system)
5. [Event Visibility & Eligibility](#5-event-visibility--eligibility)
6. [Security Features](#6-security-features)
7. [API Reference](#7-api-reference)
8. [Database Schema](#8-database-schema)
9. [UI/UX Guide](#9-uiux-guide)
10. [Testing](#10-testing)

---

## 1. Overview

Nexus Gate is an attendance tracking system for educational institutions. It prevents cheating via:

- **Tier 1**: Ed25519 signed scan certificates (offline-resilient, tamper-proof)
- **Tier 2**: Multi-frame liveness (2 FPS QR rotation, 3+ frames required)
- **One-attempt policy**: Unique constraint on (eventId, accountId)
- **Strict visibility**: Students see only their course's events

### Roles

| Role | Capabilities |
|------|-------------|
| **ADMIN** | Full access: accounts, events, whitelist, audit logs, maintenance, overrides |
| **ORGANIZER** | Create/manage own events, project QR, view attendance, create overrides |
| **USER** (Student) | Dashboard, scanner, profile, change password |

---

## 2. Architecture

```
Browser → Caddy Gateway → Next.js App (port 3000) → Prisma → SQLite/PostgreSQL
                         → Realtime Mini-Service (port 3003, optional)
```

### Key Files

| Path | Purpose |
|------|---------|
| `src/proxy.ts` | Middleware: CSRF, CSP, security headers |
| `src/lib/auth.ts` | JWT, bcrypt, HMAC, refresh tokens |
| `src/lib/session.ts` | Session management, token rotation |
| `src/lib/qr-token.ts` | QR token generation + validation (v8) |
| `src/lib/scan-certificate.ts` | Scan certificate creation + verification |
| `src/lib/device-key-client.ts` | Ed25519 keypair (IndexedDB) |
| `src/lib/device-key-server.ts` | Ed25519 signature verification |
| `src/lib/event-visibility.ts` | Strict event filtering predicate |
| `src/lib/validation.ts` | Zod schemas for all API inputs |
| `src/lib/password-strength.ts` | Shared password scorer |
| `src/lib/rate-limit.ts` | Rate limiting (memory/Upstash) |

---

## 3. Authentication & Authorization

### Session Flow

1. **Login** (`POST /api/auth/login`): Email + password → bcrypt verify → JWT access (15min) + refresh token (7d) cookies
2. **Refresh** (`POST /api/auth/refresh`): Refresh token → HMAC-SHA256 hash → O(1) DB lookup → rotate token (revoke old, issue new)
3. **Logout** (`POST /api/auth/logout`): Revoke refresh token, clear cookies
4. **Reuse Detection**: If a revoked token is presented → revoke ALL tokens for that account

### Registration Flow (No OTP)

1. **Register** (`POST /api/auth/register`): Creates account as `PENDING_VERIFICATION`
2. **Login**: First successful login flips status to `ACTIVE` (proves credentials were saved correctly)
3. No email verification / OTP step required

### Authorization

Every API route uses `requireAuth(minimumRole)`:
- Verifies session cookie (JWT)
- Re-queries account status from DB (suspended = instant lockout)
- Checks maintenance mode
- Enforces per-account rate limit (100/min)
- Checks role hierarchy (ADMIN > ORGANIZER > USER)

### Password Security

- **Hashing**: bcrypt cost 12
- **Strength**: `strongPasswordSchema` scores passwords 0-6; minimum 4 required for password changes
- **Cooldown**: 30 days between password changes
- **Server-side enforced**: Client cannot bypass the strength check

### Profile Cooldowns

- **Profile update**: 30 days between updates
- **Course change**: Once per account (tracked via `courseModifiedAt`)
- **Year/Section consistency**: Section prefix must match year (e.g. Year 3 → "3-A")

---

## 4. QR Attendance System

### Token Format (v8)

```
<eventId>.<timeBlock>.<subFrame>.<subHmac>
```

- **timeBlock**: 15-second window (`Math.floor(Date.now() / 15000)`)
- **subFrame**: 0-29 within each block (500ms each)
- **subHmac**: `HMAC-SHA256(eventSecret, "eventId:timeBlock:subFrame")`

### QR Projection (Organizer)

- QR refreshes at **2 FPS** (every 500ms)
- Only the event **owner** or **admin** can project (no delegation to other organizers)
- The `eventSecret` is never exposed to students

### Scanning (Student)

1. Student's camera captures QR frames
2. Each frame is parsed for `eventId`, `timeBlock`, `subFrame`, `subHmac`
3. The scanner collects sub-frames until it has **3+ consecutive** ones
4. A **scan certificate** is created:
   - eventId, token, scannedAt, nonce, deviceFingerprint, subFrames (with HMACs)
5. The certificate is **signed** with the device's Ed25519 private key
6. The signed certificate is enqueued (offline queue in localStorage)
7. When online, the certificate is sent to `POST /api/attendance`

### Server-Side Verification (10 layers)

1. Zod schema validation
2. One-attempt early check (before crypto)
3. Ed25519 signature verification (device key must be registered)
4. Certificate timestamp validation (±60s skew, 15-min sync window)
5. Token HMAC validation (against cert's `scannedAt`, not sync time)
6. Multi-frame liveness (3+ consecutive sub-frames with valid HMACs)
7. Event match (cert eventId = token eventId)
8. Event eligibility (strict program + section match)
9. Time window validation (check-in must be open)
10. Atomic insert (unique constraint on eventId + accountId)

### Offline Queue

- Queue items are stored in `localStorage` (key: `ng_scan_queue_v2`)
- Each item contains a **signed certificate** (tamper-proof)
- Exponential backoff + jitter on retry (avoids thundering herd)
- Auto-syncs when `navigator.onLine` returns true

---

## 5. Event Visibility & Eligibility

### Strict Visibility Rule (v8)

A student sees an event in their list if and only if:

| Condition | Visible? |
|-----------|----------|
| Open to all (both targetProgram AND targetSection null) | ✅ |
| Exact program + section match | ✅ |
| Program-wide (targetProgram set, targetSection null) | ❌ Hidden |
| Different program | ❌ Hidden |
| Different section | ❌ Hidden |

### Attendance Eligibility (matches visibility)

The scan endpoint enforces the **same** rule. A student who can see the event can scan it. A student who cannot see it cannot scan it.

### QR Projection (No Delegation)

- **Admin**: can project ANY event
- **Event Owner**: can project their own event
- **Other Organizers**: RESTRICTED — cannot project another organizer's event

---

## 6. Security Features

### 8 Security Layers

1. **Authentication**: JWT (15min) + rotating refresh tokens (7d) with reuse detection
2. **Authorization**: RBAC (ADMIN/ORGANIZER/USER) with server-enforced checks
3. **Input Validation**: Zod schemas on every API input
4. **CSRF Defense**: Origin/Referer check + SameSite=Lax cookies
5. **Rate Limiting**: Per-IP (unauth) + per-account (auth); fail-closed for sensitive presets
6. **Cryptography**: Ed25519 (certificates), HMAC-SHA256 (QR tokens), bcrypt (passwords), timing-safe comparisons
7. **Database Security**: RLS on all tables, guard trigger on accounts, CHECK constraints
8. **HTTP Headers**: CSP (no unsafe-eval), X-Frame-Options, HSTS, Permissions-Policy

### File Upload Security

- **Extensions**: Only `.xlsx`, `.xls`, `.pdf`, `.docx`, `.csv` accepted
- **MIME types**: Validated server-side (defense-in-depth)
- **Size limit**: 10MB
- **Validation**: Both client-side (instant rejection) and server-side (cannot be bypassed)

### Full Name Validation

- Numbers are stripped on input (client-side)
- Server-side `fullNameSchema` rejects names with numbers or special characters
- Applied to: registration, profile update, admin account creation, admin account update

---

## 7. API Reference

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | None | Create account (PENDING_VERIFICATION) |
| POST | `/api/auth/login` | None | Login + activate account |
| POST | `/api/auth/logout` | Any | Revoke refresh token |
| GET | `/api/auth/me` | Any | Get current account |
| POST | `/api/auth/refresh` | Refresh cookie | Rotate refresh token |
| POST | `/api/auth/forgot-password` | None | Send reset email |
| POST | `/api/auth/reset-password` | None | Reset password with token |

### Events

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/events` | Any | List visible events (with search/filter/sort) |
| POST | `/api/events` | ORGANIZER+ | Create event |
| GET | `/api/events/[id]` | Any | Get event details (no eventSecret for students) |
| PATCH | `/api/events/[id]` | ORGANIZER+ | Update event |
| DELETE | `/api/events/[id]` | ORGANIZER+ | Soft/hard delete event |
| GET | `/api/events/[id]/secret` | ORGANIZER+ | Get eventSecret for QR projection (owner/admin only) |
| GET | `/api/events/[id]/details` | Any | Get event details + student's attendance |
| GET | `/api/events/[id]/attendance` | ORGANIZER+ | List attendance for an event |

### Attendance

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/attendance` | USER | Submit signed scan certificate |
| POST | `/api/attendance/override` | ORGANIZER+ | Manual check-in (no QR) |
| GET | `/api/attendance/overrides` | ORGANIZER+ | List overrides (paginated) |

### Profile

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/profile` | Any | Get full profile + cooldown flags |
| PATCH | `/api/profile` | Non-admin | Update profile (30-day cooldown) |
| POST | `/api/profile/password` | Any | Change password (30-day cooldown, strength enforced) |
| GET | `/api/profile/device-key` | Any | List registered devices |
| POST | `/api/profile/device-key` | Any | Register device public key (max 5) |

### Accounts (Admin)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/accounts` | ADMIN | List accounts (paginated) |
| POST | `/api/accounts/create` | ADMIN | Create organizer/admin account |
| PATCH | `/api/accounts/[id]` | ADMIN | Update account (last-admin guard) |
| DELETE | `/api/accounts/[id]/delete` | ADMIN | Delete account (last-admin guard) |

### Whitelist (Students)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/whitelist` | ORGANIZER+ | List students (paginated, searchable) |
| POST | `/api/whitelist` | ORGANIZER+ | Import students (JSON) |
| POST | `/api/whitelist/import-file` | ORGANIZER+ | Import students (file upload) |
| GET | `/api/whitelist/template` | ORGANIZER+ | Download CSV template |
| DELETE | `/api/whitelist/[studentId]` | ORGANIZER+ | Delete student |

### Other

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/dashboard` | Any | Role-aware dashboard data |
| GET | `/api/settings` | None | Public settings (maintenance mode) |
| GET | `/api/health` | None | Health check |
| GET | `/api/notifications` | Any | List notifications |
| GET | `/api/audit-logs` | ADMIN | Audit log (paginated) |
| POST | `/api/admin/maintenance` | ADMIN | Toggle maintenance mode |
| GET | `/api/cron/event-reminders` | Cron secret | Send event reminders |
| GET | `/api/cron/cleanup` | Cron secret | Clean up expired tokens |

---

## 8. Database Schema

### Models (11)

1. **Account** — Users (admin, organizer, student) with auth + profile fields
2. **AuthorizedStudent** — Pre-approved student whitelist
3. **VerificationToken** — OTP tokens (legacy, kept for compatibility)
4. **RefreshToken** — Rotating session tokens (HMAC-SHA256 hashed, O(1) lookup)
5. **Event** — Attendance events with program/section targeting
6. **EventAttendance** — Check-in records with certificate fields
7. **AttendanceOverride** — Manual check-ins (idempotent: `@@unique([eventId, studentId])`)
8. **Notification** — User notifications
9. **AuditLog** — Immutable audit trail
10. **DeviceKey** — Ed25519 public keys per device
11. **Setting** — Key-value settings

### Key Constraints

- `Account.email` — UNIQUE
- `Account.studentId` — UNIQUE
- `EventAttendance.(eventId, accountId)` — UNIQUE (one-attempt policy)
- `EventAttendance.idempotencyKey` — UNIQUE
- `EventAttendance.certificateNonce` — UNIQUE
- `AttendanceOverride.(eventId, studentId)` — UNIQUE (idempotent overrides)
- `RefreshToken.tokenHash` — UNIQUE (O(1) lookup)
- `DeviceKey.fingerprint` — UNIQUE

---

## 9. UI/UX Guide

### Responsive Design

All pages are mobile-first with breakpoints:
- **Mobile** (< 640px): Single column, card-based tables, stacked forms
- **Tablet** (640-1024px): 2-column grids, horizontal tables
- **Desktop** (> 1024px): Multi-column grids, sticky sidebars

### Filter Toolbars

All filter/sort toolbars follow a consistent pattern:
- Unified grid (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-N`)
- Consistent `h-9` input height
- "Clear" button in the header row (top-right)
- Debounced 300ms search

### Color System

- **Primary**: Amber (`bg-primary`, `text-primary`)
- **No indigo or blue colors** (per design specification)
- **Dark mode**: Full support via `next-themes`

### Touch Targets

- Minimum 44px for all interactive elements on mobile
- Compact buttons: `h-9` (36px)
- Standard buttons: `h-10` (40px)

---

## 10. Testing

### Unit Tests (361 tests)

```bash
bun run test
```

### Test Categories

| Category | Tests | Key Files |
|----------|-------|-----------|
| Auth | 6 | `auth.test.ts` — bcrypt, HMAC |
| QR Tokens | 46 | `qr-token.test.ts` — v8 format, sub-frames, liveness |
| Validation | 48 | `validation.test.ts` — Zod schemas |
| Integration | 28 | `scan-flow.integration.test.ts` — full flow, anti-cheat |
| Visibility | 26 | `event-visibility.test.ts` — strict filtering |
| Password | 27 | `password-strength.test.ts` — scoring |
| Certificates | 21 | `scan-certificate.test.ts` — creation, idempotency |
| Event Time | 19 | `event-time.test.ts` — time window validation |
| Cooldowns | 18 | `cooldown.test.ts` — 30-day logic |
| Pagination | 17 | `pagination.test.ts` — schema + helpers |
| Section | 14 | `section-validation.test.ts` — year/section consistency |
| ICS Export | 12 | `ics-export.test.ts` — calendar export |
| Ably Token | 10 | `ably/token/route.test.ts` — signing, key parsing |
| WebAuthn | 16 | `webauthn-context.test.ts` + `passkey-credential.test.ts` |
| Rate Limit | 8 | `rate-limit.test.ts` — Upstash + in-memory |
| Device Key | 4 | `device-key-server.test.ts` — Ed25519 verification |

### E2E Testing

E2E tests are performed via Agent Browser:
1. Registration → login → dashboard → scanner → profile
2. Admin: accounts, events, whitelist, attendance, overrides, audit logs
3. Responsive: mobile (390px) + desktop (1440px)
4. Security: CSRF, rate limiting, auth bypass attempts

### Lint

```bash
bun run lint
```

---

## Appendix: Supabase Migrations

| # | File | Description |
|---|------|-------------|
| 1 | `0001_init.sql` | Initial schema |
| 2 | `0002_settings_and_views.sql` | Settings + summary views |
| 3 | `0003_strict_rls_indexes_v7.sql` | RLS + composite indexes |
| 4 | `0004_device_keys_certificates_v8.sql` | DeviceKey table + certificate fields |
| 5 | `0005_security_hardening_scalability_v8.sql` | RLS guard trigger, CHECK constraints, idempotent overrides |
