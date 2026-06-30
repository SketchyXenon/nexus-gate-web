# Nexus Gate — Architecture & Security Reference

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT (Browser)                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐ │
│  │ Dashboard │  │ Scanner  │  │ Profile  │  │ Project QR  │ │
│  └─────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬──────┘ │
│        │              │              │               │       │
│  ┌─────┴──────────────┴──────────────┴───────────────┴─────┐ │
│  │              API Client (React Query)                    │ │
│  │  + IndexedDB (Ed25519 device key)                        │ │
│  │  + localStorage (offline scan queue v2)                  │ │
│  └───────────────────────┬──────────────────────────────────┘ │
└──────────────────────────┼────────────────────────────────────┘
                           │ HTTPS (relative URLs)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    CADDY GATEWAY (:81/:443)                  │
│  - TLS termination                                           │
│  - Body size limit (10MB)                                    │
│  - Security headers                                          │
│  - XTransformPort whitelist (port 3003 only)                 │
└──────────────────────────┬────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  NEXT.JS APP (Port 3000)                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  API Routes (App Router)                              │   │
│  │  /api/auth/*        — login, register, refresh        │   │
│  │  /api/events/*      — CRUD + eligibility filtering    │   │
│  │  /api/attendance    — QR scan (certificate verified)  │   │
│  │  /api/profile/*     — profile, password, device keys  │   │
│  │  /api/accounts/*    — admin account management        │   │
│  │  /api/whitelist/*   — student roster + file import    │   │
│  │  /api/dashboard     — role-aware dashboard data       │   │
│  │  /api/notifications — push notifications              │   │
│  │  /api/cron/*        — Vercel Cron (reminders, cleanup)│   │
│  └────────────────────────┬─────────────────────────────┘   │
│  ┌────────────────────────┴─────────────────────────────┐   │
│  │  Middleware (proxy.ts)                                │   │
│  │  - CSRF Origin/Referer check                          │   │
│  │  - CSP / X-Frame-Options / HSTS                       │   │
│  │  - Dev: relaxed frame-ancestors for preview panels    │   │
│  └────────────────────────┬─────────────────────────────┘   │
│  ┌────────────────────────┴─────────────────────────────┐   │
│  │  Security Layer                                       │   │
│  │  - requireAuth() — session + role + status + rate     │   │
│  │  - Zod validation on every input                      │   │
│  │  - Timing-safe HMAC comparison                        │   │
│  │  - Password strength scorer (server-side)             │   │
│  │  - 30-day profile + password cooldowns                │   │
│  └────────────────────────┬─────────────────────────────┘   │
└───────────────────────────┼──────────────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼               ▼               ▼
┌──────────────────┐ ┌────────────────┐ ┌──────────────────┐
│   Prisma + DB    │ │  Rate Limiter  │ │  Audit Logger    │
│  (SQLite / PG)   │ │ (Memory/Upstash)│ │  (DB-backed)     │
│                  │ │                │ │                  │
│  11 models:      │ │ Presets:       │ │ Every mutation   │
│  Account         │ │ login (5/min)  │ │ logged with      │
│  Event           │ │ register(3/min)│ │ actor, IP, UA    │
│  EventAttendance │ │ scan (30/min)  │ │                  │
│  DeviceKey       │ │ api (120/min)  │ │                  │
│  RefreshToken    │ │                │ │                  │
│  AuditLog        │ │ Fail-closed    │ │                  │
│  Notification    │ │ for sensitive  │ │                  │
│  ...             │ │ presets        │ │                  │
└──────────────────┘ └────────────────┘ └──────────────────┘
```

## Anti-Cheating Architecture (QR Attendance)

### Tier 1: Signed Scan Certificates
- Each device has an Ed25519 keypair (private in IndexedDB, public registered with server)
- Scan certificates bind the QR token to the device + timestamp + nonce
- Server validates token HMAC against the certificate's `scannedAt` (not sync time)
- Enables offline sync: a scan made at 9 AM that syncs at 2 PM is still valid

### Tier 2: Multi-Frame Liveness
- QR refreshes at 2 FPS (every 500ms) with sub-frame-specific HMACs
- Scanner must capture 3+ consecutive sub-frames WITH their client-observed HMACs
- Server verifies each client-supplied HMAC against the server-recomputed value
- A single photo captures only 1 sub-frame → rejected (insufficient frames)

### One-Attempt Policy
- `@@unique([eventId, accountId])` on `EventAttendance` — atomic at the DB level
- Early "already scanned" check before any crypto work
- Race conditions fall back to P2002 unique constraint catch

## Security Layers

### 1. Authentication
- JWT access tokens (15-min TTL) with issuer + audience + type discriminator
- Refresh tokens (7-day TTL) with rotation + reuse detection (revokes all on reuse)
- HMAC-SHA256 hashed refresh tokens (O(1) lookup via unique index)
- Cookies: `httpOnly`, `sameSite: lax`, `secure: true` in production

### 2. Authorization (RBAC)
- Three roles: `ADMIN`, `ORGANIZER`, `USER`
- `requireAuth(minimumRole)` on every API route
- Account status re-checked from DB on every request (suspended = instant lockout)
- Maintenance mode blocks non-admins

### 3. Input Validation
- Zod schemas on every API input
- Strict file extension + MIME type validation on uploads
- Program codes validated against `PROGRAM_CODES` set
- Pagination capped at 100 per page

### 4. CSRF Defense
- Origin/Referer check in middleware (proxy.ts)
- SameSite=Lax cookies (primary defense)
- Port-insensitive hostname comparison (handles gateway port differences)
- X-Forwarded-Host support for reverse proxies

### 5. Rate Limiting
- Per-IP for unauthenticated endpoints (login, register, forgot-password)
- Per-account for authenticated endpoints (100/min default)
- Fail-closed for sensitive presets (login, register, OTP) on Upstash errors
- Scan endpoint: 30/min per account (not IP — correct for shared WiFi)

### 6. Cryptography
- HMAC-SHA256 for QR token signing
- Ed25519 for scan certificate signatures (Web Crypto API on client, Node crypto on server)
- bcrypt (cost 12) for password hashing
- HMAC-SHA256 (peppered with REFRESH_SECRET) for refresh token hashing
- Timing-safe comparisons for all HMAC verifications

### 7. Database Security
- Row-Level Security (RLS) on all 11 tables (Supabase)
- Guard trigger on `accounts` prevents self-escalation via REST API
- Service role bypasses RLS (used by the Next.js backend)
- CHECK constraints on all enum-like columns

### 8. HTTP Security Headers
- Content-Security-Policy (no `unsafe-eval`, `object-src: none`)
- X-Frame-Options (DENY in prod, SAMEORIGIN in dev)
- X-Content-Type-Options: nosniff
- Strict-Transport-Security (HSTS with preload)
- Permissions-Policy (camera=self, microphone=(), geolocation=())
- X-XSS-Protection: 0 (modern browsers use CSP)

## Testing

### Unit Tests (262 tests)
```bash
bun run test
```

| File | Tests | Coverage |
|------|-------|----------|
| `auth.test.ts` | 15 | Password hashing, JWT, refresh tokens |
| `qr-token.test.ts` | 37 | v8 token generation, validation, sub-frame liveness |
| `scan-certificate.test.ts` | 21 | Certificate creation, canonicalization, idempotency |
| `scan-flow.integration.test.ts` | 24 | Full end-to-end scan flow, anti-cheat simulations |
| `validation.test.ts` | 39 | Zod schemas, OTP removal verification |
| `password-strength.test.ts` | 34 | Password scoring |
| `section-validation.test.ts` | 42 | Year/section consistency |
| `event-visibility.test.ts` | 32 | Strict event filtering |
| `cooldown.test.ts` | 18 | 30-day cooldown logic |

### Lint
```bash
bun run lint
```

### E2E Testing (Agent Browser)
- Registration → login → dashboard → scanner → profile flow
- Admin: accounts, events, whitelist, attendance, overrides, audit logs
- Organizer: events, project QR, attendance, overrides
- Student: dashboard, scanner, profile, change password

## Database Schema (v9)

### Models
1. **Account** — users (admin, organizer, student)
2. **AuthorizedStudent** — pre-approved student whitelist
3. **VerificationToken** — OTP tokens (unused after OTP removal, kept for compatibility)
4. **RefreshToken** — rotating session tokens (HMAC-SHA256 hashed)
5. **Event** — attendance events with program/section targeting
6. **EventAttendance** — check-in records with certificate fields
7. **AttendanceOverride** — manual check-ins (idempotent: `@@unique([eventId, studentId])`)
8. **Notification** — user notifications
9. **AuditLog** — immutable audit trail
10. **DeviceKey** — Ed25519 public keys per device
11. **Setting** — key-value settings (maintenance mode, etc.)

### Key Indexes
- `events`: `[status, scheduledAt]`, `[targetProgram, targetSection, status]`
- `event_attendance`: `[accountId, scannedAt]`, `[eventId, scannedAt]`
- `notifications`: `[accountId, createdAt]`, `[accountId, readAt]`
- `audit_logs`: `[actorId, createdAt]`, `[action, createdAt]`, `[targetType, targetId, createdAt]`
- `refresh_tokens`: `[tokenHash]` (unique, O(1) lookup)
- `device_keys`: `[fingerprint]` (unique), `[accountId, revokedAt]`

## Supabase Migrations

| # | File | Description |
|---|------|-------------|
| 1 | `0001_init.sql` | Initial schema (tables, indexes, views) |
| 2 | `0002_settings_and_views.sql` | Settings table + summary views |
| 3 | `0003_strict_rls_indexes_v7.sql` | RLS on all tables + composite indexes + `is_admin()` function |
| 4 | `0004_device_keys_certificates_v8.sql` | DeviceKey table + certificate fields on EventAttendance |
| 5 | `0005_security_hardening_scalability_v8.sql` | RLS guard trigger, CHECK constraints, idempotent overrides, restricted `is_admin()` |

**Apply in order** via the Supabase SQL Editor.
