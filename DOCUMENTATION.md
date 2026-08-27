# Nexus Gate - Full Documentation

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
Browser → Caddy Gateway → Next.js App (port 3000) → Prisma → SQLite (dev) / TiDB Serverless (prod)
                         → Realtime Mini-Service (port 3003, optional)
```

> **Database**: App data lives in **TiDB Serverless** (MySQL-compatible, prod) or SQLite (local dev). Supabase is used for **auth only** (sessions/JWT/email). TiDB has no built-in RLS — row scoping is enforced at the app layer. See [docs/tidb-data-protection.md](./docs/tidb-data-protection.md).

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
| `src/lib/rate-limit.ts` | Rate limiting (memory/Aiven Redis) |

---

## 3. Authentication & Authorization

### Session Flow

1. **Login** (`POST /api/auth/login`): Email + password (+ optional `rememberMe` boolean, default false) → Supabase `signInWithPassword` → app-layer brute-force lockout (5 fails → 15-min `lockedUntil`, set via atomic compare-and-set). **Enumeration-safe**: wrong-password, non-existent email, unconfirmed email, and deactivated account all return an identical generic 401. A dummy `bcrypt.compare` runs on the not-found path to equalize timing. **Remember me**: checked → 30-day HttpOnly persistent session cookie (sticky via the `ng_sess` marker so refreshes keep the policy); unchecked → browser-session cookie; ADMIN accounts are force session-scoped. The 30-min inactivity logout applies regardless.
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
- **Cooldown**: 30 days between password changes, enforced via a TOCTOU-safe conditional `updateMany` (compare-and-set on `lastPasswordChangeAt`) so concurrent requests cannot halve the cooldown
- **Server-side enforced**: Client cannot bypass the strength check

### Profile Cooldowns

- **Profile update**: 30 days between updates, enforced via the same TOCTOU-safe compare-and-set on `lastProfileUpdateAt`
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

| Condition | Visible to students? |
|-----------|----------|
| Open to all (both targetProgram AND targetSection null) | ✅ |
| Program-wide (targetProgram set, targetSection null) — student in that program | ✅ |
| Exact program + section match | ✅ |
| Program-wide — student in a different program | ❌ Hidden |
| Different program | ❌ Hidden |
| Different section | ❌ Hidden |
| Student has no program/section set | Only open-to-all events |

### Organizer Visibility (owns + v8)

An organizer sees an event in their list if it is v8-visible to them **OR** they own it. The "owns" clause is critical: an organizer who creates a section-specific event (and has no matching section on their own profile) would never see their own event without it. Admins see all events.

### Program-Scoped Organizers

Organizers are limited to their own program scope:

- Must have a program assigned (else they cannot create events).
- **Cannot create department-wide (open-to-all) events** — reserved for admins.
- `targetProgram` is forced to the organizer's own program (e.g. a BSIT organizer can only create BSIT-scoped events).

### Attendance Eligibility (matches visibility)

The scan endpoint enforces the **same** rule. A student who can see the event can scan it. A student who cannot see it cannot scan it.

### QR Projection & Delegation (program-based)

- **Admin**: can project ANY event.
- **Event Owner**: can project their own event (any scope).
- **Other Organizers**: can project ONLY program-wide events (scope=academic, targetProgram set, targetSection null) where the owner opted in (`delegatable`), AND the delegate's program matches the event's `targetProgram`.
- Department-wide events are never delegatable (open to all, unnecessary privilege).
- Section-specific ("specified") events are never delegatable (small enough that only the owner/admin projects).

---

## 6. Security Features

### 8 Security Layers

1. **Authentication**: Supabase Auth (cookie-based, PKCE) + app-layer brute-force lockout (5 fails → 15-min, atomic compare-and-set). **Enumeration-safe login** - single generic 401 for all failure paths + dummy bcrypt timing equalization.
2. **Authorization**: RBAC (ADMIN/ORGANIZER/USER) with server-enforced checks on every route, including object-level (BOLA) on dynamic `[id]` routes and the Ably token route (event visibility check)
3. **Input Validation**: Zod schemas on every API input; explicit field allowlists on all mutations (no mass assignment)
4. **CSRF Defense**: Origin/Referer check + SameSite=Lax cookies
5. **Rate Limiting**: Per-IP (unauth) + per-account (auth) + dedicated presets for admin mutations (20/min), whitelist imports (3/min), file uploads (5/min), passkey registration (10/min). Sensitive presets fail closed on limiter error. In-memory fallback LRU-capped at 10k keys.
6. **Cryptography**: Ed25519 (certificates), HMAC-SHA256 (QR tokens), bcrypt (passwords), timing-safe comparisons, stable P2002 detection via Prisma error code
7. **Database Security**: App-layer row scoping (TiDB has no RLS — see [docs/tidb-data-protection.md](./docs/tidb-data-protection.md)); centralized visibility predicates, server-side BOLA checks, TLS in transit, connection-pool caps, audit logging, soft-delete pattern
8. **HTTP Headers**: CSP (no unsafe-eval), X-Frame-Options, HSTS, Permissions-Policy

### Error Handling (OWASP A10)

- Error responses reveal only what the user needs, never stack traces or internal state
- The `accounts/create` route returns a generic "Unable to create the account" message; the raw DB error is logged server-side only (closes an email-enumeration oracle)
- DB unavailability surfaces as 503 `DB_UNAVAILABLE`, not 500

### Concurrency Controls (TOCTOU-safe)

- **Scan one-attempt**: atomic `create` with `@@unique([eventId, accountId])`; P2002 caught via stable code-based detection and returned as `already_scanned`
- **Login lockout**: increment is atomic; lock-set is a compare-and-set `updateMany({ where: { lockedUntil: null } })`
- **Profile/password cooldown**: conditional `updateMany` (where `lastChangedAt` null OR lt cutoff); if 0 rows affected, a concurrent request won the race
- **Override idempotency**: `@@unique([eventId, studentId])` + P2002 catch inside a `$transaction`

### File Upload Security (5-layer defense-in-depth)

The whitelist import (`POST /api/whitelist/import-file`) validates the file's **actual content** (magic bytes), not just the client-provided filename/MIME. A renamed executable (`sample.exe` → `sample.docx`) is blocked before any parser runs. Implemented in `src/lib/file-security.ts`.

1. **Filename hygiene** — rejects control characters (incl. null bytes), path traversal, leading/trailing dots, and any blocked-extension token anywhere in the name (`.xlsm`, `.xlsb`, `.exe`, `.js`, `.doc`, etc.).
2. **Extension allowlist** — only `.xlsx`, `.xls`, `.pdf`, `.docx`, `.csv`.
3. **Magic-byte sniff (authoritative)** — reads the file's true signature (ZIP `PK\x03\x04`, PDF `%PDF-`, OLE2 `D0CF11E0`, CSV printable-text heuristic). Disambiguates `.xlsx` vs `.docx` (both ZIP containers) by scanning the first 4 KB for `spreadsheetml`/`wordprocessingml` markers.
4. **MIME consistency** — cross-checks the declared MIME vs the extension (defense-in-depth).
5. **Content sanity** — rejects zero-length/empty files.

The parser dispatches on the **sniffed** kind (not the untrusted filename), so a genuine `.csv` mislabeled as `.xlsx` is routed to the CSV parser by its true content. Stable error codes (`BLOCKED_EXTENSION`, `CONTENT_EXTENSION_MISMATCH`, `KIND_EXTENSION_MISMATCH`, `MIME_EXTENSION_MISMATCH`, etc.) drive precise UI feedback.

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
| POST | `/api/attendance` | USER | Submit signed scan certificate (atomic one-attempt via unique constraint + stable P2002 detection) |
| POST | `/api/attendance/override` | ORGANIZER+ | Offline-first manual check-in: Ed25519-signed override certificate (device-bound). Organizer: own events only; Admin: any. Server validates signature + canonical round-trip + clock skew (±120s) + 24h sync deadline + event window at the SIGNED creation time + eligibility; atomic `$transaction` + P2002 idempotency; 30/min fail-closed rate limit; forensic audit (device, drift, sync delay, offline flag). |
| GET | `/api/attendance/overrides` | ORGANIZER+ | List overrides (organizer: own events; admin: all) with forensic fields |

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
| POST | `/api/accounts/batch` | ADMIN | Batch activate/suspend/setRole (200-id cap, last-admin guard, self-action block; no bulk delete) |

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
| GET | `/api/ably/token` | Any | Sign Ably TokenRequest (subscribe-only, single channel). **Enforces event visibility** - students cannot subscribe to another section's channel. |
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

1. **Account** - Users (admin, organizer, student) with auth + profile fields
2. **AuthorizedStudent** - Pre-approved student whitelist
3. **VerificationToken** - OTP tokens (legacy, kept for compatibility)
4. **RefreshToken** - Rotating session tokens (HMAC-SHA256 hashed, O(1) lookup)
5. **Event** - Attendance events with program/section targeting
6. **EventAttendance** - Check-in records with certificate fields
7. **AttendanceOverride** - Manual check-ins (idempotent: `@@unique([eventId, studentId])`)
8. **Notification** - User notifications
9. **AuditLog** - Immutable audit trail
10. **DeviceKey** - Ed25519 public keys per device
11. **Setting** - Key-value settings

### Key Constraints

- `Account.email` - UNIQUE
- `Account.studentId` - UNIQUE
- `EventAttendance.(eventId, accountId)` - UNIQUE (one-attempt policy)
- `EventAttendance.idempotencyKey` - UNIQUE
- `EventAttendance.certificateNonce` - UNIQUE
- `AttendanceOverride.(eventId, studentId)` - UNIQUE (idempotent overrides)
- `RefreshToken.tokenHash` - UNIQUE (O(1) lookup)
- `DeviceKey.fingerprint` - UNIQUE

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

### Unit Tests (368 tests)

```bash
bun run test
```

### Test Categories

| Category | Tests | Key Files |
|----------|-------|-----------|
| Auth | 6 | `auth.test.ts` - bcrypt, HMAC |
| QR Tokens | 46 | `qr-token.test.ts` - v8 format, sub-frames, liveness |
| Validation | 48 | `validation.test.ts` - Zod schemas |
| Integration | 28 | `scan-flow.integration.test.ts` - full flow, anti-cheat |
| Visibility | 26 | `event-visibility.test.ts` - strict filtering |
| Password | 27 | `password-strength.test.ts` - scoring |
| Certificates | 21 | `scan-certificate.test.ts` - creation, idempotency |
| Event Time | 19 | `event-time.test.ts` - time window validation |
| Cooldowns | 21 | `cooldown.test.ts` - 30-day logic + TOCTOU-safe cutoff helper |
| Pagination | 17 | `pagination.test.ts` - schema + helpers |
| Section | 14 | `section-validation.test.ts` - year/section consistency |
| ICS Export | 12 | `ics-export.test.ts` - calendar export |
| Ably Token | 10 | `ably/token/route.test.ts` - signing, key parsing |
| WebAuthn | 16 | `webauthn-context.test.ts` + `passkey-credential.test.ts` |
| Rate Limit | 8 | `rate-limit.test.ts` - Aiven Redis + in-memory |
| Prisma Errors | 4 | `prisma-errors.test.ts` - stable P2002 detection |
| Device Key | 4 | `device-key-server.test.ts` - Ed25519 verification |

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

## Appendix: Legacy Supabase (Postgres) Migrations

> These SQL migrations are the **legacy Postgres schema** from when the app
> data lived in Supabase. The app data has since migrated to **TiDB
> Serverless** (MySQL-compatible); these files are retained for historical
> reference and for any deployment still on Postgres. The active TiDB schema
> is `prisma/schema.tidb.prisma`. Supabase is now used for **auth only**.
> See [docs/tidb-data-protection.md](./docs/tidb-data-protection.md) for the
> RLS-replacement controls.

| # | File | Description |
|---|------|-------------|
| 1 | `0001_init.sql` | Initial schema |
| 2 | `0002_settings_and_views.sql` | Settings + summary views |
| 3 | `0003_strict_rls_indexes_v7.sql` | RLS + composite indexes (Postgres-only; TiDB uses app-layer scoping) |
| 4 | `0004_device_keys_certificates_v8.sql` | DeviceKey table + certificate fields |
| 5 | `0005_security_hardening_scalability_v8.sql` | RLS guard trigger, CHECK constraints, idempotent overrides (Postgres-only) |
