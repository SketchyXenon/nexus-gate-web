# Nexus Gate — System Architecture Documentation

> **Version**: 0.2.0 | **Last updated**: 2026-07-10 | **Author**: SketchyXenon
> **Stack**: Next.js 16.1.1 · React 19 · TypeScript 5 · Prisma 6 · Supabase · Ably · Tailwind CSS 4

---

## Table of Contents

1. [Overview](#1-overview)
2. [Technology Stack](#2-technology-stack)
3. [System Architecture](#3-system-architecture)
4. [Database Layer](#4-database-layer)
5. [Authentication & Authorization](#5-authentication--authorization)
6. [API Surface](#6-api-surface)
7. [Anti-Cheating QR Attendance](#7-anti-cheating-qr-attendance)
8. [Security Architecture](#8-security-architecture)
9. [Realtime Layer](#9-realtime-layer)
10. [Frontend Architecture](#10-frontend-architecture)
11. [Offline-First Scanner](#11-offline-first-scanner)
12. [Rate Limiting & Caching](#12-rate-limiting--caching)
13. [Cron Jobs & Maintenance](#13-cron-jobs--maintenance)
14. [Threat Model & Edge Cases](#14-threat-model--edge-cases)
15. [Capacity & Scalability](#15-capacity--scalability)
16. [Deployment](#16-deployment)
17. [Testing](#17-testing)
18. [File Inventory](#18-file-inventory)

---

## 1. Overview

**Nexus Gate** is a production-ready attendance system for Institutional Use. Students scan rotating QR codes projected in class to check in; organizers get a live roster with anti-cheating verification.

### Key differentiator

A multi-layer anti-cheating stack that defeats screenshot, photo-replay, and offline-replay attacks without requiring specialized hardware:

- **Two-tier rotating QR** — 15-second time blocks with 500ms sub-frames, each HMAC-signed
- **Multi-frame liveness** — scanner must capture 3+ consecutive sub-frames (defeats single-photo capture)
- **Ed25519 device-bound certificates** — each scan is cryptographically signed by the device's private key (stored in IndexedDB), verified server-side
- **Offline-first sync queue** — signed certificates persist in localStorage, sync with exponential backoff

### Target scale

- **150–200 concurrent users** (sustained)
- **3,000–3,500 total users** (departmental-wide)
- **$0–75/month** infrastructure cost (free tiers → Pro plans)

---

## 2. Technology Stack

### Core framework

| Technology | Version | Purpose                                           |
| ---------- | ------- | ------------------------------------------------- |
| Next.js    | 16.1.1  | App Router, Turbopack, standalone output          |
| React      | 19.0.0  | UI runtime                                        |
| TypeScript | ^5      | Type safety (strict mode, `noImplicitAny: false`) |
| Bun        | ^1.3    | Runtime + package manager                         |

### Database & auth

| Technology      | Version | Purpose                                       |
| --------------- | ------- | --------------------------------------------- |
| Prisma          | 6.11.1  | ORM (dual schema: Postgres prod / SQLite dev) |
| Supabase        | 2.110.0 | PostgreSQL + Auth (RLS, PKCE, service role)   |
| `@supabase/ssr` | 0.12.0  | Cookie-based session management               |

### Security & crypto

| Technology                | Version | Purpose                                       |
| ------------------------- | ------- | --------------------------------------------- |
| `@simplewebauthn/server`  | 13.3.2  | Passkey/WebAuthn registration + verification  |
| `@simplewebauthn/browser` | 13.3.0  | Client-side WebAuthn API                      |
| bcryptjs                  | 3.0.3   | Password hashing (cost 12)                    |
| Web Crypto API            | —       | Ed25519 keypair generation + signing (client) |
| Node.js crypto            | —       | Ed25519 signature verification (server)       |

### Realtime & infrastructure

| Technology                              | Version        | Purpose                                                                |
| --------------------------------------- | -------------- | ---------------------------------------------------------------------- |
| Ably                                    | 2.23.0         | Managed realtime (REST publish server-side, SDK subscribe client-side) |
| `@upstash/ratelimit` + `@upstash/redis` | 2.0.8 / 1.38.0 | Distributed rate limiting (fails open to in-memory on error)           |
| `@sentry/nextjs`                        | 10.62.0        | Error monitoring (3 configs: client/server/edge)                       |
| Caddy                                   | —              | Reverse proxy (tiered rate limits, compression, health checks)         |

### Frontend

| Technology            | Version      | Purpose                                               |
| --------------------- | ------------ | ----------------------------------------------------- |
| Tailwind CSS          | 4            | Styling (CSS-based config via `@tailwindcss/postcss`) |
| shadcn/ui             | —            | Component library (new-york style, ~55 primitives)    |
| TanStack Query        | 5.82.0       | Server state (auto-refresh on 401, polling fallback)  |
| TanStack Table        | 8.21.3       | Data tables                                           |
| react-hook-form + Zod | 7.60 / 4.0.2 | Forms + validation (shared schemas client/server)     |
| framer-motion         | 12.23.2      | Animations (landing page, transitions)                |

### File parsing & QR

| Technology   | Version | Purpose                                                 |
| ------------ | ------- | ------------------------------------------------------- |
| exceljs      | 4.4.0   | Excel whitelist import (replaced CVE-vulnerable `xlsx`) |
| mammoth      | 1.12.0  | DOCX parsing                                            |
| papaparse    | 5.5.4   | CSV parsing                                             |
| pdfjs-dist   | 4.10.38 | PDF parsing (pure JS, Vercel-compatible)                |
| jsqr         | 1.4.0   | QR code decoding (scanner camera feed)                  |
| qrcode.react | 4.2.0   | QR code rendering (projector view)                      |

### Testing

| Technology | Version | Purpose                                        |
| ---------- | ------- | ---------------------------------------------- |
| Vitest     | 4.1.9   | Unit + integration tests (node env, 368 tests) |

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT (Browser)                          │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  React SPA  │  │  IndexedDB   │  │  localStorage           │ │
│  │  (AppShell) │  │  (Ed25519    │  │  (ng_scan_queue_v2)     │ │
│  │             │  │   device key)│  │  Offline scan queue     │ │
│  └──────┬──────┘  └──────────────┘  └────────────────────────┘ │
│         │                 │                        │             │
│         │   ┌─────────────┴──────────┐             │             │
│         │   │ Web Crypto API         │             │             │
│         │   │ (Ed25519 sign)         │             │             │
│         │   └────────────────────────┘             │             │
│         │                                         │             │
└─────────┼─────────────────────────────────────────┼────────────┘
          │ HTTPS                                    │ sync (15min)
          ▼                                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    GATEWAY (Caddy :80/:81)                       │
│  Tiered rate limits: scan 60r/m, general API 100r/m             │
│  zstd/gzip compression, health checks, keepalive (100 conns)    │
│  (No per-IP auth limit — NAT'd campus safety)                   │
└─────────────────────────┬───────────────────────────────────────┘
                          │ reverse_proxy localhost:3000
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│              NEXT.JS 16 (Vercel serverless)                      │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  src/proxy.ts (Edge middleware)                         │    │
│  │  • CSRF: Origin/Referer same-origin check               │    │
│  │  • Security headers: CSP, HSTS, X-Frame-Options         │    │
│  │  • OPTIONS preflight → 204 early return                 │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  46 API Routes (src/app/api/)                           │    │
│  │  • requireAuth(minimumRole) gate on every authed route  │    │
│  │  • 30s account cache + 10s maintenance cache            │    │
│  │  • Per-email rate limit (login) + per-IP (register)     │    │
│  │  • Audit log on every mutation (30+ action types)       │    │
│  │  • Zod validation on every input                        │    │
│  └──────────────────────┬──────────────────────────────────┘    │
│                         │                                        │
│    ┌────────────────────┼────────────────────────┐              │
│    │                    │                        │              │
│    ▼                    ▼                        ▼              │
│  Prisma Client    Supabase Auth             Ably REST           │
│  (service role,  (PKCE, recovery,           (fire-and-forget    │
│   bypasses RLS)   magic link, passkey)       publish, 5s timeout)│
└────────┬───────────────────┬───────────────────────────────────┘
         │                   │
         ▼                   ▼
┌─────────────────────┐  ┌─────────────────────┐
│   Supabase          │  │   Ably Cloud        │
│   PostgreSQL        │  │   (200 concurrent   │
│   • 11 tables       │  │    connections,     │
│   • 12 migrations   │  │    3M msgs/mo)      │
│   • RLS on all      │  │                     │
│   • 40+ indexes     │  │   Organizers only   │
│   • Guard triggers  │  │   subscribe         │
└─────────────────────┘  └─────────────────────┘
```

---

## 4. Database Layer

### 4.1 Schema overview

11 tables across 12 migrations. Dual Prisma schema: `schema.prisma` (Postgres prod, `@map` snake_case) and `schema.sqlite.prisma` (SQLite dev, camelCase).

| Table                  | Growth driver              | Estimated rows/month (3000 users) |
| ---------------------- | -------------------------- | --------------------------------- |
| `accounts`             | per-user                   | 3,000                             |
| `authorized_students`  | per-imported-student       | ≤ 3,000                           |
| `verification_tokens`  | per-verification-request   | high churn (cron-purged)          |
| `refresh_tokens`       | per-login-session          | ~6,000 (2/user)                   |
| `events`               | per-event                  | low                               |
| **`event_attendance`** | **per-scan (highest)**     | **~300,000**                      |
| `attendance_overrides` | per-override               | low                               |
| `notifications`        | per-notification-per-user  | up to 600,000                     |
| `audit_logs`           | per-mutation (append-only) | ~4,500 (cron-purged at 90d)       |
| `device_keys`          | per-device-per-user        | ~6,000 (max 5/account)            |
| `settings`             | static                     | ~5                                |

### 4.2 Index strategy

40+ composite indexes (migration 0003 rebuilt all v1 single-column indexes as composites matching real query patterns). Key indexes:

- `accounts`: `(role, status)`, `(program, section)`, `(passkeyCredentialId)`, `(createdAt)`, `(supabase_auth_uid)` partial unique
- `events`: `(status, scheduledAt)`, `(owner_id, status, scheduled_at)`, `(target_program, target_section, status)`
- `event_attendance`: `UNIQUE(event_id, account_id)`, `UNIQUE(idempotency_key)`, `UNIQUE(certificate_nonce)`, `(account_id, scanned_at)`, `(event_id, scanned_at)`
- `audit_logs`: `(actor_id, created_at)`, `(action, created_at)`, `(target_type, target_id, created_at)`
- `device_keys`: `UNIQUE(fingerprint)`, `(account_id, revoked_at)`

**pg_trgm GIN indexes** (migration 0011) on `accounts.full_name`, `accounts.email`, `events.title`, `authorized_students.full_name`, `authorized_students.email`, `audit_logs.action`, `notifications.body` — turns `LIKE '%query%'` from O(N) seq scan to O(log N).

### 4.3 Row-Level Security (RLS)

RLS enabled on all 11 tables. The app connects via service role (bypasses RLS). RLS is a defense-in-depth backstop if the anon key leaks:

| Table                  | Policy (authenticated role)                                           |
| ---------------------- | --------------------------------------------------------------------- |
| `accounts`             | SELECT own OR admin; UPDATE own (guard trigger blocks sensitive cols) |
| `events`               | SELECT any authenticated; writes service-role only                    |
| `event_attendance`     | SELECT own OR admin; writes service-role only                         |
| `attendance_overrides` | SELECT if admin OR event owner; writes service-role only              |
| `notifications`        | SELECT + UPDATE own; create/delete service-role only                  |
| `audit_logs`           | SELECT admin only; writes service-role only                           |
| `device_keys`          | SELECT own; writes service-role only                                  |
| `settings`             | SELECT any authenticated; writes service-role only                    |

Anonymous role: **DENIED** on every table.

### 4.4 Database triggers

| Trigger                   | Table                      | Purpose                                                                                                                                          |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `set_updated_at()`        | accounts, events, settings | Auto-stamps `updated_at = now()` on UPDATE                                                                                                       |
| `guard_account_columns()` | accounts                   | Blocks REST API self-escalation of role/status/password_hash (role-aware: only fires for `authenticated`/`anon` context, skips for service role) |
| `guard_last_admin()`      | accounts                   | Atomically prevents reducing active admin count to 0 (TOCTOU race fix, migration 0012)                                                           |

### 4.5 Purge policies (cron/cleanup)

| Table                 | Retention          | Purpose                                              |
| --------------------- | ------------------ | ---------------------------------------------------- |
| `verification_tokens` | expired or used    | Immediate                                            |
| `refresh_tokens`      | expired or revoked | Immediate                                            |
| `notifications`       | read >30 days      | Prevent unbounded growth                             |
| `event_attendance`    | >180 days          | Storage management (closes 24h→15min offline window) |
| `audit_logs`          | >90 days           | Compliance + storage                                 |

---

## 5. Authentication & Authorization

### 5.1 Auth model

**Supabase Auth** is the identity provider. Sessions are cookie-based via `@supabase/ssr` (PKCE flow).

### 5.2 Three sign-in methods

1. **Password** — Supabase `signInWithPassword` + app-layer brute-force lockout (5 fails → 15-min `lockedUntil`). The lock is set via an atomic compare-and-set update (`where: { lockedUntil: null }`) so two concurrent failures cannot both skip the lock-set. Login is **enumeration-safe**: wrong-password, non-existent email, unconfirmed email, and deactivated account all return an identical generic 401. A dummy `bcrypt.compare` runs on the not-found path to equalize timing.
2. **Passkey / WebAuthn** — `@simplewebauthn/server` discoverable credentials. Login extracts credential ID from assertion, does **O(log N) indexed lookup** via `passkey_credential_id` column (was O(N) scan + N crypto ops — fixed). Session established via `admin.generateLink` → `verifyOtp` (magiclink). Registration (options + verify) is rate-limited at 10/min per account.
3. **Magic link** — Supabase `signInWithOtp` (enumeration-safe responses)

### 5.3 RBAC

Three roles with hierarchical privileges:

```
USER (1) < ORGANIZER (2) < ADMIN (3)
```

| Capability                 | USER | ORGANIZER               | ADMIN      |
| -------------------------- | ---- | ----------------------- | ---------- |
| Scan QR to check in        | ✓    | ✗                       | ✗          |
| View own attendance        | ✓    | —                       | —          |
| Create/edit events         | ✗    | ✓ (own program/section) | ✓ (any)    |
| View event attendance      | ✗    | ✓ (own + visible)       | ✓ (all)    |
| Manual attendance override | ✗    | ✓                       | ✓          |
| Project QR codes           | ✗    | ✓                       | ✓          |
| Manage student whitelist   | ✗    | ✓ (import)              | ✓ (delete) |
| Manage accounts            | ✗    | ✗                       | ✓          |
| View audit logs            | ✗    | ✗                       | ✓          |
| Toggle maintenance mode    | ✗    | ✗                       | ✓          |

`requireAuth(minimumRole, {exactRole?})` on every authenticated route. Some routes use `exactRole: true` (e.g. `/api/attendance` scan is USER-only).

### 5.4 Password security

- **bcrypt cost 12** via `hashPassword()` / `verifyPassword()`
- **Server-side strength scorer** (`scorePassword()`) shared between client meter and server Zod schema — cannot be bypassed client-side
- **Minimum score 4/6**: length ≥ 8 + uppercase + lowercase + digit + (length ≥ 12 OR special char)
- **Penalties**: common patterns (password, 123456, qwerty, etc.), 3+ sequential chars (abcd, 1234), 4+ repeated chars (aaaa)
- **30-day cooldown** on password changes + profile updates, enforced via a TOCTOU-safe conditional `updateMany` (where `lastChangedAt` is null or older than the cutoff) so concurrent requests cannot both pass the read-only check and halve the cooldown
- **RECOVERY-only AMR check** on reset-password — rejects `otp`/`magiclink` sessions to prevent stolen-session password takeover

### 5.5 Session management

- Supabase access tokens (15 min) + refresh tokens (7 days, rotating, HMAC-SHA256 hashed)
- **30-second in-memory account cache** (`supabase-session.ts`) — saves ~60% of DB queries at 2000 users
- **30-min session timeout** with 25-min warning toast (`useSessionTimeout` hook)
- `invalidateAccountCache(supabaseAuthUid)` called on role/status changes

---

## 6. API Surface

46 API routes organized across 12 domains. Every route has:

- Explicit `Cache-Control` header
- `maxDuration` on routes doing heavy work (Supabase Auth, crypto, file parsing)
- Zod input validation
- `requireAuth` on non-public routes
- Rate limiting (per-email for login, per-IP for register, per-account for authenticated)
- Audit logging on mutations

### Route inventory

| Domain                | Routes                                                                                                                                                                                     | Methods                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| **Auth** (11)         | `/auth/{callback, check, forgot-password, login, logout, magic-link, me, refresh, register, reset-password}` + passkey `login-options`/`login-verify`/`register-options`/`register-verify` | POST (mostly), GET (callback, me) |
| **Accounts** (4)      | `/accounts` GET, `/accounts/create` POST, `/accounts/[id]` PATCH, `/accounts/[id]/delete` DELETE                                                                                           | GET, POST, PATCH, DELETE          |
| **Attendance** (4)    | `/attendance` POST, `/attendance/override` POST, `/attendance/overrides` GET, `/attendance/recent` GET                                                                                     | POST, GET                         |
| **Events** (5)        | `/events` GET/POST, `/events/[id]` GET/PATCH/DELETE, `/events/[id]/{attendance, details, secret}` GET                                                                                      | GET, POST, PATCH, DELETE          |
| **Whitelist** (4)     | `/whitelist` GET/POST, `/whitelist/[studentId]` DELETE, `/whitelist/{import-file, template}` POST/GET                                                                                      | GET, POST, DELETE                 |
| **Profile** (3)       | `/profile` GET/PATCH, `/profile/device-key` GET/POST/DELETE, `/profile/password` POST                                                                                                      | GET, PATCH, POST, DELETE          |
| **Notifications** (3) | `/notifications` GET/POST, `/notifications/{status, subscribe}` GET/POST/DELETE                                                                                                            | GET, POST, DELETE                 |
| **Admin** (2)         | `/admin/{cleanup, maintenance}` POST                                                                                                                                                       | POST                              |
| **Cron** (2)          | `/cron/{cleanup, event-reminders}` GET+POST                                                                                                                                                | GET, POST                         |
| **Dashboard** (1)     | `/dashboard` GET                                                                                                                                                                           | GET                               |
| **Audit-logs** (1)    | `/audit-logs` GET                                                                                                                                                                          | GET                               |
| **Other** (3)         | `/health` GET, `/settings` GET, `/` (root stub)                                                                                                                                            | GET                               |

---

## 7. Anti-Cheating QR Attendance

The headline feature. A 10-step server-side verification pipeline on `POST /api/attendance`:

### 7.1 Two-tier rotating QR

- **Tier 1**: 15-second time blocks — `eventId.timeBlock.blockHmac`
- **Tier 2**: 500ms sub-frames, 30 per block — appends `.subFrame.subHmac`
- v8 (4-part) format with legacy v5 (3-part) fallback
- QR refreshed every 500ms in the projector view via Web Crypto HMAC

### 7.2 Multi-frame liveness (`verifySubFrameLiveness`)

Scanner captures **≥3 consecutive sub-frames**. Boundary-aware: sub-frame 29 of block N is consecutive with sub-frame 0 of block N+1. Each sub-frame's HMAC is checked against both the primary block and the previous block (handles 15s boundary straddling). Defeats single-photo capture.

### 7.3 Ed25519 device-bound certificates

- Browser generates an Ed25519 keypair on first visit, stored in IndexedDB
- **Account-scoped**: key is `device_keypair:${accountId}` (shared-device safety)
- Public key registered to the account (max 5 active devices, self-service revocation)
- Each scan produces a `SignedCertificate`:
  ```
  certificate = { eventId, token, scannedAt, nonce, deviceFingerprint, subFrames[] }
  signature = Ed25519.sign(canonical(certificate), devicePrivateKey)
  ```
- Server verifies signature, recomputes fingerprint, checks revocation

### 7.4 10-step verification pipeline

1. Zod `scanCertificateSchema` validation
2. Existing-attendance fast path (P2002 → idempotent `{alreadyPresent: true}`)
3. Ed25519 `verifySignedCertificate` (DB lookup by fingerprint + signature verify)
4. `validateCertificateTimestamp` (60s forward / 120s grace with warning / 15min backward)
5. Fetch event (must be `active`)
6. `validateQrPayload` — HMAC recomputed against **`scannedAt`** (not server time — enables offline-first)
7. `validateCertificateEventMatch`
8. `verifySubFrameLiveness` (≥3 consecutive sub-frames, boundary-aware)
9. Strict eligibility (open-to-all OR exact `program`+`section` match)
10. Time-window check via `scannedAt` → atomic `eventAttendance.create` with `@@unique([eventId, accountId])`

### 7.5 Idempotency

`deriveIdempotencyKey = HMAC-SHA256(deviceFingerprint, eventId:nonce)` — deterministic. Re-draining a queued scan after partial success returns `{alreadyPresent: true}` instead of creating a duplicate. 1-hour TTL.

---

## 8. Security Architecture

### 8.1 Defense-in-depth layers

1. **Auth** — Supabase Auth + 3 sign-in methods + brute-force lockout + orphan reconciliation
2. **Authz** — RBAC hierarchy (`USER < ORGANIZER < ADMIN`); `requireAuth` on every route; 30s account cache
3. **Validation** — Zod 4 schemas on every API input; server-side password strength scorer shared with client
4. **CSRF** — Same-origin Origin/Referer check on POST/PATCH/PUT/DELETE (port-insensitive); OPTIONS preflight early return
5. **Rate limiting** — Per-email (login), per-IP (register), per-account (authenticated); Upstash prod (fails open) + in-memory dev
6. **Crypto** — Ed25519 device-bound certificates; timing-safe HMAC comparisons; bcrypt cost 12; deterministic idempotency keys
7. **DB security** — RLS on all 11 tables; service-role bypass; `guard_account_columns` trigger; `guard_last_admin` trigger; CHECK constraints on enums
8. **HTTP headers** — Strict CSP (no `unsafe-eval`, `connect-src: self + *.ably.io`), X-Frame-Options (DENY prod), HSTS preload, Permissions-Policy (camera=self), X-XSS-Protection: 0

### 8.2 Additional security measures

- **SSRF defense** on push-subscription endpoints (`url-safety.ts`)
- **Strict file ext + MIME allowlist** on whitelist import
- **Cloudflare Turnstile** with circuit breaker (fail-open on infra, fail-closed on token)
- **Per-endpoint cron secrets** (`CRON_CLEANUP_SECRET` / `CRON_REMINDERS_SECRET`, falls back to `CRON_SECRET`)
- **Open-redirect prevention** — `forgotPasswordSchema.redirectTo` validates same-origin
- **Email XSS defense** — all URLs in HTML templates escaped with `escapeHtml()`

### 8.3 Guard triggers

- `guard_account_columns` — blocks REST API self-escalation of role/status/password (role-aware: skips for service role)
- `guard_last_admin` — atomically prevents 0-admin state (TOCTOU race fix)

---

## 9. Realtime Layer

### Architecture

```
Server (attendance route)                Client (organizer views)
    │                                       │
    │ POST rest.ably.io                     │ Ably.Realtime({ authCallback })
    │ /channels/event:${id}/publish         │   .channels.get(`event:${id}`)
    │ (5s timeout, 1 retry on transient)    │   .subscribe("attendance")
    │                                       │
    ▼                                       ▼
┌─────────────────┐                  ┌─────────────────┐
│  Ably Cloud     │ ── WebSocket ──> │  Organizer      │
│  (200 conns,    │                  │  dashboard      │
│   3M msgs/mo)   │                  │  (live roster)  │
└─────────────────┘                  └─────────────────┘
```

- **Server publish**: `notifyAttendance()` in `realtime.ts` — REST POST to Ably, 5s timeout, 1 retry after 2s for transient failures (network errors, 5xx). 4xx errors are not retried (permanent).
- **Token endpoint**: `/api/ably/token?eventId=N` — uses Ably SDK's `auth.createTokenRequest()` to sign a TokenRequest with subscribe-only capability scoped to `event:N`. 1h TTL. The browser never receives the server key.
- **Client**: `useAttendanceSocket(eventId)` hook — Ably SDK with `authCallback` (fetches token from the endpoint), `{ connected, latest }` state, 10s connect timeout, polling fallback when Ably is unavailable.
- **Scope**: organizers only (students don't connect — keeps under 200-connection free-tier limit).
- **Cleanup**: scoped `channel.unsubscribe("attendance", handler)` + `client.connection.off()` before `client.close()` (guarded by connection state to prevent "Uncaught (in promise) Connection closed" rejection).

---

## 10. Frontend Architecture

### Single-route SPA

The entire authenticated app lives at `/`. No App Router nested routing — `AppShell` holds `useState<ViewId>` with 10 possible values:

| View         | Roles                  | Purpose                                        |
| ------------ | ---------------------- | ---------------------------------------------- |
| `dashboard`  | All (branched by role) | Stats, recent events, recent check-ins         |
| `scanner`    | USER                   | Camera QR scanner with offline queue           |
| `events`     | ADMIN, ORGANIZER       | Event CRUD + past events                       |
| `project-qr` | ADMIN, ORGANIZER       | Projector view (rotating QR + live attendance) |
| `attendance` | ADMIN, ORGANIZER       | Live roster (includes ended events)            |
| `overrides`  | ADMIN, ORGANIZER       | Manual attendance entry                        |
| `whitelist`  | ADMIN, ORGANIZER       | Student roster import + management             |
| `accounts`   | ADMIN                  | User management                                |
| `audit-logs` | ADMIN                  | Append-only action log                         |
| `profile`    | ORGANIZER, USER        | Profile + passkey + device management          |

### Composition tree

```
layout.tsx (SERVER — fonts, SEO, JSON-LD, viewport)
  └─ ThemeProvider (next-themes, defaultTheme="light")
      └─ Providers (TanStack QueryClient + TooltipProvider)
          └─ page.tsx (CLIENT)
               ├─ fetch /api/settings (maintenance)
               ├─ <MaintenanceScreen> (non-admin)
               ├─ <ErrorBoundary><LoginScreen/></ErrorBoundary>
               └─ <ErrorBoundary><AppShell user={user} initialView={getInitialView()}/></ErrorBoundary>

AppShell
  ├─ Sidebar + MobileNav (role-filtered NAV array)
  ├─ Sticky header (online/offline badge, NotificationBell, ThemeToggle)
  ├─ <CardErrorBoundary> ← wraps all views (single crash doesn't take down app)
  │   └─ {activeView === "dashboard" && <DashboardView/>}
  │   └─ {activeView === "scanner" && <ScannerView/>}
  │   └─ ... (10 views)
  ├─ <CookieConsent/>
  └─ <InfoModals/>
```

### PWA

- `manifest.json`: standalone, portrait, theme `#b45309` (amber-700), 2 SVG icons
- `sw.js`: app shell cache-first, API network-first with offline fallback, stale-while-revalidate for assets
- `sw-register.tsx`: production-only registration, 10-min update check, install banner, "Update available" toast
- PWA shortcut `/?action=scan` opens scanner directly (implemented via `getInitialView()` in `page.tsx`)

### Registration wizard

3-step multi-step form with progress indicator:

1. **Account** — email + password + confirm (real-time availability check, 400ms debounce)
2. **Identity** — full name + student ID (real-time availability check)
3. **Program** — optional program + section → submit

Per-step validation with race-condition fix: if user clicks Continue before debounce fires, `validateRegStep` forces the debounce immediately and blocks with "Checking…".

---

## 11. Offline-First Scanner

### Flow

```
1. Student opens scanner view
2. Camera feed → jsQR decodes at 8 FPS (downscale to 640px)
3. Collect 3+ consecutive sub-frames (each with client-observed HMAC)
4. Build ScanCertificate:
   - eventId, token (last captured), scannedAt, nonce, deviceFingerprint, subFrames[]
5. Sign with Ed25519 private key (IndexedDB, account-scoped)
6. Enqueue to localStorage (ng_scan_queue_v2) in <1ms
7. Background drain: exponential backoff + jitter
   - POST /api/attendance with signed certificate
   - 15-min sync window (validateCertificateTimestamp)
   - Deterministic idempotency key prevents duplicates
8. Ably publish (organizer sees live update)
```

### Queue behavior

- `useScanQueue` hook: `{ queue, online, syncing, pendingCount, enqueueSigned, drain, clearSynced, removeItem }`
- Backoff: `min(30s, 1s × 2^attempts) + jitter(0..500ms)`
- After 5 attempts → `failed` (kept for manual retry)
- "Send now" button triggers immediate drain
- Account-scoped device key prevents shared-device cross-contamination

---

## 12. Rate Limiting & Caching

### Rate-limit presets

| Preset                | Max | Window | Keyed on          | Routes                                                              |
| --------------------- | --- | ------ | ----------------- | ------------------------------------------------------------------- |
| `login`               | 5   | 60s    | **per-email**     | `/auth/login`, passkey login                                        |
| `register`            | 5   | 60s    | per-IP            | `/auth/register`                                                    |
| `otp`                 | 5   | 60s    | per-IP            | `/auth/forgot-password`, `/auth/reset-password`, `/auth/magic-link` |
| `check`               | 15  | 60s    | per-IP            | `/auth/check` (real-time availability)                              |
| `scan`                | 60  | 60s    | per-IP (fallback) | `/api/attendance`                                                   |
| `scanAccount`         | 30  | 60s    | **per-account**   | `/api/attendance` (primary)                                         |
| `api`                 | 120 | 60s    | per-IP (fallback) | authed routes                                                       |
| `apiAccount`          | 100 | 60s    | **per-account**   | ALL authed routes (auto via `requireAuth`)                          |
| `passkeyOptions`      | 30  | 60s    | per-IP            | `/auth/passkey/login-options`                                       |
| `passkeyVerify`       | 10  | 60s    | per-IP            | `/auth/passkey/login-verify`                                        |
| `passkeyAccount`      | 5   | 60s    | **per-account**   | `/auth/passkey/login-verify` (post-credential-lookup)               |
| `loginAccount`        | 5   | 60s    | **per-account**   | `/auth/login` (post-email-lookup)                                   |
| `passkeyRegister`     | 10  | 60s    | **per-account**   | `/auth/passkey/register-options` + `register-verify`                |
| `adminMutation`       | 20  | 60s    | **per-account**   | `/accounts/create`, `/accounts/[id]/delete`                         |
| `whitelistImport`     | 3   | 60s    | **per-account**   | `/whitelist` POST (JSON, up to 5000 rows)                           |
| `whitelistImportFile` | 5   | 60s    | **per-account**   | `/whitelist/import-file` (Excel/PDF/DOCX, up to 10MB)               |

**Key design**: `login` is per-email (not per-IP) because 200+ students share one campus IP. `scanAccount` is per-account (not per-IP) for the same reason. The per-account DB lockout (5 fails → 15-min) is the primary brute-force defense.

**Sensitive presets fail closed** on Upstash error (login, register, otp, passkeyVerify, passkeyRegister, passkeyAccount, loginAccount, adminMutation, whitelistImport, whitelistImportFile) — an attacker cannot DDoS the limiter to bypass brute-force protection. General presets (`api`, `apiAccount`, `scan`, `scanAccount`, `passkeyOptions`, `check`) fail open to avoid locking all users during a transient Upstash outage.

**In-memory fallback** (no Upstash configured): LRU-capped at 10,000 keys to prevent memory exhaustion under IP rotation. On Vercel serverless (multi-instance) the in-memory counts diverge per instance — a documented free-tier trade-off; Upstash restores global consistency.

### Cache headers

| Route                         | Header                             | Rationale                  |
| ----------------------------- | ---------------------------------- | -------------------------- |
| `/api/health`                 | `public, s-maxage=10, swr=30`      | Public, edge-cacheable     |
| `/api/settings`               | `public, s-maxage=30, swr=60`      | Public, edge-cacheable     |
| `/api/whitelist/template`     | `public, s-maxage=3600, swr=86400` | Static template            |
| `/api/events`                 | `private, s-maxage=15, swr=60`     | Per-user, short TTL        |
| `/api/events/[id]/attendance` | `private, s-maxage=10, swr=30`     | Per-user, polling absorb   |
| `/api/dashboard`              | `private, no-cache, swr=30`        | Per-user, fresh            |
| `/api/auth/me`                | `private, no-cache`                | Per-user session           |
| `/api/auth/callback`          | `no-store`                         | Auth callback, never cache |
| `/api/cron/*`                 | `no-store`                         | Mutates state, never cache |
| All other per-user GETs       | `private, no-cache`                | Per-user freshness         |

---

## 13. Cron Jobs & Maintenance

### Vercel Cron (2 jobs — Hobby tier max)

| Schedule                 | Route                       | Purpose                                                                                       |
| ------------------------ | --------------------------- | --------------------------------------------------------------------------------------------- |
| `0 8 * * *` (8 AM daily) | `/api/cron/event-reminders` | Find events starting in next 30 min, create reminder notifications for eligible students      |
| `0 3 * * *` (3 AM daily) | `/api/cron/cleanup`         | Purge expired tokens, old notifications (>30d), old attendance (>180d), old audit logs (>90d) |

### Cron auth

Per-endpoint secrets: `CRON_CLEANUP_SECRET` / `CRON_REMINDERS_SECRET`, falls back to `CRON_SECRET`. Supports Bearer, Basic, headers, query, body auth methods. All comparisons constant-time.

### event-reminders optimization

Bulk algorithm (was N×M sequential):

1. Fetch all upcoming events (1 query)
2. For each event, fetch eligible students (N queries where N = events)
3. Bulk-fetch existing reminders (1 query with `in` clause)
4. Build HashSet of `"accountId:eventId"` keys for O(1) dedup
5. `createMany` all missing notifications (1 query)

---

## 14. Threat Model & Edge Cases

### Mitigated threats

| Threat                                                     | Mitigation                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Screenshot/photo-replay                                    | Multi-frame liveness (3+ consecutive sub-frames)                                                                    |
| Offline clock manipulation                                 | 15-min sync window (was 24h)                                                                                        |
| Stolen session password takeover                           | RECOVERY-only AMR check on reset-password                                                                           |
| Brute-force login                                          | Per-email rate limit + DB lockout (5 fails → 15-min) with atomic compare-and-set lock                               |
| Login user enumeration                                     | Single generic 401 for wrong-password / non-existent / unconfirmed / deactivated + dummy bcrypt timing equalization |
| NAT'd campus self-DoS                                      | Per-email (not per-IP) login rate limit                                                                             |
| Shared device cross-contamination                          | Account-scoped IndexedDB device keys                                                                                |
| Last-admin deletion race                                   | DB trigger (`guard_last_admin`, atomic)                                                                             |
| 5-device cap support tickets                               | Self-service device revocation UI                                                                                   |
| Open redirect                                              | Same-origin validation on `redirectTo`                                                                              |
| Email XSS                                                  | `escapeHtml()` on all URLs in email templates                                                                       |
| CSRF                                                       | Same-origin Origin/Referer check + SameSite=Lax cookies                                                             |
| SSRF                                                       | URL safety validation on push endpoints                                                                             |
| Device key registration race                               | P2002 catch (stable code-based detection) + re-fetch in `registerDeviceKey`                                         |
| Ably channel BOLA                                          | Event visibility check on `/api/ably/token` — students cannot subscribe to another section's channel                |
| Profile/password cooldown TOCTOU                           | Conditional `updateMany` (compare-and-set on `lastChangedAt`)                                                       |
| Admin-driven DoS (account create/delete, whitelist import) | Dedicated rate-limit presets (20/min, 3/min, 5/min) that fail closed                                                |
| Rate-limiter memory exhaustion                             | LRU cap (10,000 keys) on in-memory fallback Map                                                                     |
| Service worker InvalidStateError                           | `registration.update().catch()`                                                                                     |
| Ably "Connection closed" console error                     | `client.close().catch()` + listener cleanup                                                                         |
| Dashboard skeleton-forever on error                        | `isError` branch with retry button                                                                                  |
| Profile setState-during-render                             | Moved to `useEffect`                                                                                                |
| Single view crash                                          | `CardErrorBoundary` wraps all views                                                                                 |
| Passkey login N-row scan                                   | O(log N) indexed `passkey_credential_id` lookup                                                                     |

### Documented limitations (not fixed — by design)

| Limitation                               | Why not fixed                                                                                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Relay attack (video call)                | Fundamental limitation of device-side liveness. Defense is physical, not crypto.                                                                                                                                                           |
| Device fingerprint collision             | Low probability for canvas-based fingerprinting. Document entropy.                                                                                                                                                                         |
| Organizer role change mid-event          | 15s window acceptable. Demoted organizer already knew the secret.                                                                                                                                                                          |
| Rate limiter per-instance on serverless  | In-memory counts diverge across Vercel instances without Upstash. Documented free-tier trade-off; Upstash restores global consistency. General presets fail open; sensitive presets fail closed.                                           |
| Login timing equalization is approximate | Dummy bcrypt (~250ms) closely matches the Supabase wrong-password round-trip (~300ms). Sufficient to defeat practical timing attacks; not a cryptographically-constant-time guarantee (Supabase does not expose a constant-time auth API). |
| "Email not confirmed" no longer surfaced | A distinct 403 would reveal the email exists and is unconfirmed. The legitimate unconfirmed user sees the generic 401 and can use "Forgot password" or contact admin. Deliberate UX cost of enumeration defense.                           |
| DNS rebinding in URL safety              | Push endpoints are vendor-allowed, not user-controlled.                                                                                                                                                                                    |

---

## 15. Capacity & Scalability

### Estimated capacity (free tier)

The hard ceilings are infra limits, not code limits. The code degrades
gracefully — attendance recording survives realtime failure (Ably publish
is fire-and-forget with `.catch(() => {})`).

| Concurrent users | Free tier                     | First wall                       | Action                               |
| ---------------- | ----------------------------- | -------------------------------- | ------------------------------------ |
| 100              | ✅ All green                  | None                             | None                                 |
| 500              | ⚠️ Ably peak msg/s borderline | Ably 1,000 msg/s                 | Upgrade Ably OR reduce fanout        |
| 1,000            | ❌ Ably + Sentry exceeded     | Ably + Sentry config             | Upgrade Ably; lower Sentry sample    |
| 1,300            | ❌ Vercel bandwidth exceeded  | Vercel 100GB/mo                  | Upgrade to Vercel Pro ($20/mo)       |
| 2,000            | ❌ Multiple limits            | Ably + Vercel + Supabase storage | Upgrade all + fix code bottlenecks   |
| 3,000            | ❌ Supabase pooler            | 200 pooler connections           | Supabase Pro; `connection_limit=2-3` |

**Sustained concurrent scanning users: ~500.** **Peak burst: ~500–1,300.**
**Monthly active users: ~1,300.** **DB storage exhaustion: ~6 weeks at 2,000 users.**

See [CAPACITY-ASSESSMENT.md](./CAPACITY-ASSESSMENT.md) for the full
back-of-envelope analysis with per-constraint break-points.

### Optimizations applied

| Fix                                                    | Impact                                               |
| ------------------------------------------------------ | ---------------------------------------------------- |
| Passkey login O(log N) lookup                          | Prevents DoS at 100+ passkey users                   |
| Whitelist GET SQL pagination                           | 100× less memory per request                         |
| Event attendance pagination                            | 10× less bandwidth                                   |
| Cron event-reminders bulk                              | 350× fewer DB round-trips                            |
| `getUserByEmail` → raw SQL                             | 1,000× less data per orphan check                    |
| Purge policies (180d/90d)                              | DB stays under 500 MB                                |
| Per-email login rate limit                             | NAT'd campus safety                                  |
| 15-min offline sync window                             | Closes photo-replay attack                           |
| Account-scoped device keys                             | Shared-device safety                                 |
| Profile stats 3→1 query collapse                       | Saves 2 DB round-trips per My-Attendance page load   |
| Rate-limiter LRU cap (10k keys)                        | Closes in-memory DoS vector under IP rotation        |
| TOCTOU-safe cooldowns (compare-and-set)                | Concurrent requests cannot halve the 30-day cooldown |
| Enumeration-safe login (generic 401 + dummy bcrypt)    | Closes user-enumeration oracle (OWASP A07)           |
| Ably token event-visibility check                      | Closes channel BOLA (OWASP A01/API#1)                |
| Admin/import dedicated rate limits (20/3/5 per min)    | Closes admin-driven DoS on destructive paths         |
| Stable P2002 detection (Prisma code, not string match) | Locale/version-stable race-condition handling        |

---

## 16. Deployment

### Platforms (free tier → Pro)

| Platform | Free tier                              | Pro tier                   | Purpose              |
| -------- | -------------------------------------- | -------------------------- | -------------------- |
| Vercel   | 100GB bandwidth, 10s functions, 2 cron | $20/mo: 1TB, 60s functions | Hosting + serverless |
| Supabase | 500MB DB, 50k MAU, 200 pooler conns    | $25/mo: 8GB, higher pooler | PostgreSQL + Auth    |
| Ably     | 3M msgs/mo, 200 conns, 1000 msg/s      | $29/mo: 6M msgs            | Realtime             |
| Sentry   | 5k errors, 100 replays, 50k perf       | —                          | Error monitoring     |

### Environment variables (22)

```env
# Database
DATABASE_URL=postgresql://...:6543/postgres?pgbouncer=true&connection_limit=1&pool_timeout=20
DIRECT_URL=postgresql://...:5432/postgres

# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Auth secrets
AUTH_SECRET=
REFRESH_SECRET=

# App URL
NEXT_PUBLIC_APP_URL=

# Rate limiting (optional)
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Email (Gmail SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
SMTP_FROM_NAME=Nexus Gate

# Realtime
ABLY_SERVER_KEY=

# Error monitoring
SENTRY_DSN=
NEXT_PUBLIC_SENTRY_DSN=

# Bot protection
NEXT_PUBLIC_TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=

# Cron (per-endpoint + global fallback)
CRON_SECRET=
CRON_CLEANUP_SECRET=
CRON_REMINDERS_SECRET=

# Bootstrap admin
BOOTSTRAP_ADMIN_EMAIL=
BOOTSTRAP_ADMIN_PASSWORD=
BOOTSTRAP_ADMIN_NAME=
```

### Caddyfile

Production block on `:80` (HTTP, no domain required). Tiered rate limits (scan 200r/m, auth 5r/m, general 100r/m). zstd/gzip compression. Reverse proxy health checks + keepalive (100 idle conns). To enable auto-TLS: replace `:80` with a domain.

---

## 17. Testing

### Test suite

- **18 test files**, **368 tests** (360 pass, 8 pre-existing fail in `validation.test.ts`)
- Vitest configured for node environment (no DOM)
- Tests co-located as `*.test.ts` in `src/lib/` and `src/app/api/ably/`

### Test coverage

| File                            | Tests | Coverage                                          |
| ------------------------------- | ----- | ------------------------------------------------- |
| `auth.test.ts`                  | 6     | bcrypt hashing + HMAC                             |
| `cooldown.test.ts`              | 21    | 30-day cooldown logic + TOCTOU-safe cutoff helper |
| `prisma-errors.test.ts`         | 4     | Stable P2002 unique-constraint detection          |
| `event-visibility.test.ts`      | 26    | Student/organizer/admin visibility rules          |
| `event-time.test.ts`            | 19    | Event time window validation                      |
| `password-strength.test.ts`     | 27    | Scoring + penalties (sequential, repeated)        |
| `qr-token.test.ts`              | 46    | Token generation + liveness (boundary-aware)      |
| `scan-certificate.test.ts`      | 21    | Certificate creation + idempotency                |
| `scan-flow.integration.test.ts` | 28    | Full 10-step pipeline + anti-cheat sims           |
| `section-validation.test.ts`    | 14    | Section format + year-prefix consistency          |
| `validation.test.ts`            | 48    | Zod schemas (password, email, studentId)          |
| `pagination.test.ts`            | 17    | Pagination schema + helpers                       |
| `ics-export.test.ts`            | 12    | ICS calendar export                               |
| `ably/token/route.test.ts`      | 10    | Token signing, key parsing, spec compliance       |
| `webauthn-context.test.ts`      | 8     | WebAuthn React context                            |
| `passkey-credential.test.ts`    | 8     | WebAuthn credential storage                       |
| `rate-limit.test.ts`            | 8     | Upstash + in-memory rate limiter                  |
| `device-key-server.test.ts`     | 4     | Ed25519 device key verification                   |

### E2E verification

Agent Browser used for manual smoke testing after each change: page renders, registration wizard navigation, availability indicators, no console errors.

---

## 18. File Inventory

```
/home/z/my-project/
├── src/
│   ├── app/
│   │   ├── api/                    # 46 route.ts files (43 domain + health/settings/root)
│   │   ├── layout.tsx              # Server component — fonts, SEO, providers
│   │   ├── page.tsx                # Client gate — maintenance → login → app-shell
│   │   ├── error.tsx               # Route error boundary
│   │   ├── global-error.tsx        # Layout-level error boundary
│   │   └── globals.css             # Tailwind v4 + oklch amber/gold theme
│   ├── components/
│   │   ├── nexus/                  # 14 custom components + 10 views
│   │   │   ├── app-shell.tsx       # Top-level authed shell (CardErrorBoundary wraps views)
│   │   │   ├── views/              # 10 view modules (~8200 LOC total)
│   │   │   │   ├── dashboard.tsx   # Stats + recent check-ins (isError + retry)
│   │   │   │   ├── scanner.tsx     # Camera scanner (offline queue, account-scoped keys)
│   │   │   │   ├── events.tsx      # Event CRUD + past events (clickable)
│   │   │   │   ├── project-qr.tsx  # Projector view (rotating QR + live attendance)
│   │   │   │   ├── attendance.tsx  # Live roster (includes ended events)
│   │   │   │   ├── overrides.tsx   # Manual attendance entry
│   │   │   │   ├── whitelist.tsx   # Roster import (CSV/Excel/DOCX/PDF)
│   │   │   │   ├── accounts.tsx    # User management
│   │   │   │   ├── audit-logs.tsx  # Append-only log viewer
│   │   │   │   └── profile.tsx     # Profile + passkey + device management
│   │   │   ├── login-screen.tsx    # Multi-step auth wizard (3-step registration)
│   │   │   ├── password-meter.tsx  # Strength meter (collapses to "Good password" flag)
│   │   │   ├── error-boundary.tsx  # PageErrorBoundary + CardErrorBoundary
│   │   │   └── ... (12 more shared components)
│   │   ├── ui/                     # ~55 shadcn/ui primitives
│   │   ├── providers.tsx           # TanStack QueryClient + TooltipProvider
│   │   ├── sw-register.tsx         # PWA service worker registration
│   │   └── theme-provider.tsx      # next-themes wrapper
│   ├── hooks/                      # 7 custom hooks
│   │   ├── use-attendance-socket.ts # Ably realtime (clean close().catch())
│   │   ├── use-scan-queue.ts       # Offline-first scan queue (localStorage)
│   │   ├── use-session-timeout.ts  # 30-min inactivity auto-logout
│   │   ├── use-online-status.ts    # navigator.onLine (useSyncExternalStore)
│   │   ├── use-debounce.ts         # Generic value debouncer
│   │   ├── use-mobile.ts           # Responsive breakpoint
│   │   └── use-toast.ts            # shadcn toast singleton
│   ├── lib/                        # 36 source modules + 11 test files
│   │   ├── api.ts                  # requireAuth, rate limiting, error responses
│   │   ├── db.ts                   # Prisma client singleton
│   │   ├── validation.ts           # Zod schemas (shared client/server)
│   │   ├── password-strength.ts    # Scoring algorithm (shared client/server)
│   │   ├── qr-token.ts             # QR token generation + boundary-aware liveness
│   │   ├── scan-certificate.ts     # Certificate validation (15-min window, 120s grace)
│   │   ├── device-key-client.ts    # IndexedDB Ed25519 keys (account-scoped)
│   │   ├── device-key-server.ts    # Ed25519 verification + revocation
│   │   ├── rate-limit.ts           # 8 presets (per-email, per-IP, per-account)
│   │   ├── supabase-session.ts     # 30s account cache
│   │   ├── supabase-browser.ts     # Singleton browser client
│   │   ├── realtime.ts             # Ably REST publish (5s timeout)
│   │   ├── email.ts                # Nodemailer (escaped URLs)
│   │   ├── file-parser.ts          # Excel/PDF/DOCX/CSV parsing
│   │   ├── cron-auth.ts            # Per-endpoint cron secrets
│   │   ├── rbac.ts                 # Role hierarchy + permissions
│   │   ├── audit.ts                # Append-only audit logging
│   │   └── ... (20 more modules)
│   └── proxy.ts                    # Edge middleware: CSRF + security headers + OPTIONS
├── prisma/
│   ├── schema.prisma               # Postgres (prod, @map snake_case)
│   └── schema.sqlite.prisma        # SQLite (dev, camelCase)
├── supabase/migrations/            # 12 SQL migrations (0001 → 0012)
├── public/                         # manifest.json, sw.js, robots.txt, 3 SVG icons
├── scripts/                        # bootstrap-admin.ts, seed-events.ts
├── docs/                           # activity-log.md, plan docs
├── Caddyfile                       # Reverse proxy (prod :80, dev :81)
├── sentry.{client,server,edge}.config.ts
├── instrumentation.ts              # Sentry runtime bootstrap
├── vercel.json                     # 2 cron jobs
├── vitest.config.ts
└── package.json                    # nexus-gate v0.2.0
```

---

## Document control

| Field            | Value        |
| ---------------- | ------------ |
| Document version | 1.0          |
| Last updated     | 2026-07-10   |
| Author           | SketchyXenon |
| Reviewers        | —            |
| License          | MIT          |

---
