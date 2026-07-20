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
│  │  + localStorage (offline scan queue)                     │ │
│  │  + Session timeout (30 min inactivity)                   │ │
│  └───────────────────────┬──────────────────────────────────┘ │
└──────────────────────────┼────────────────────────────────────┘
                           │ HTTPS
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              VERCEL (Next.js 16, App Router)                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  API Routes (43 routes)                               │   │
│  │  /api/auth/*        — login, register, magic-link,    │   │
│  │                        passkey, refresh, callback       │   │
│  │  /api/events/*      — CRUD + eligibility + delegation │   │
│  │  /api/attendance    — QR scan (certificate verified)  │   │
│  │  /api/profile/*     — profile, password, device keys  │   │
│  │  /api/accounts/*    — admin account management        │   │
│  │  /api/whitelist/*   — student roster + file import    │   │
│  │  /api/dashboard     — role-aware dashboard data       │   │
│  │  /api/notifications — push notifications              │   │
│  │  /api/cron/*        — cron (reminders, cleanup)       │   │
│  └────────────────────────┬─────────────────────────────┘   │
│  ┌────────────────────────┴─────────────────────────────┐   │
│  │  Middleware (proxy.ts)                                │   │
│  │  - CSRF Origin/Referer check (mutations only)         │   │
│  │  - CSP (connect-src: self + Ably)                     │   │
│  │  - X-Frame-Options / HSTS / nosniff                   │   │
│  │  - Cron routes exempt from CSRF                       │   │
│  └────────────────────────┬─────────────────────────────┘   │
│  ┌────────────────────────┴─────────────────────────────┐   │
│  │  Security Layer                                       │   │
│  │  - requireAuth() — session + role + status + rate     │   │
│  │  - Account cache (30s TTL) — eliminates DB lookup     │   │
│  │  - Brute-force lockout (5 attempts → 15 min lock)     │   │
│  │    atomic compare-and-set on lockedUntil (TOCTOU-safe)│   │
│  │  - Enumeration-safe login (single generic 401)        │   │
│  │  - Zod validation on every input                      │   │
│  │  - Timing-safe HMAC comparison                        │   │
│  │  - Password strength scorer (server-side)             │   │
│  │  - 30-day profile + password cooldowns (compare-and-set)│   │
│  │  - Ably token route enforces event visibility (BOLA)  │   │
│  └────────────────────────┬─────────────────────────────┘   │
└───────────────────────────┼──────────────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼               ▼               ▼
┌──────────────────┐ ┌────────────────┐ ┌──────────────────┐
│   Prisma + DB    │ │  Rate Limiter  │ │  Audit Logger    │
│  (SQLite / PG)   │ │ (Memory/Upstash)│ │  (DB-backed)     │
│                  │ │                │ │                  │
│  11 models:      │ │ Per-IP:        │ │ Every mutation   │
│  Account         │ │ login (5/min)  │ │ logged with      │
│  Event           │ │ register(5/min)│ │ actor, IP, UA    │
│  EventAttendance │ │ Per-account:   │ │                  │
│  DeviceKey       │ │ scan (30/min)  │ │                  │
│  AuditLog        │ │ api (100/min)  │ │                  │
│  Notification    │ │ admin (20/min) │ │                  │
│  ...             │ │ import (3/min) │ │                  │
│                  │ │ LRU-capped Map │ │                  │
└──────────────────┘ └────────────────┘ └──────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     ABLY (Realtime)                           │
│  - Managed realtime (no server to maintain)                   │
│  - Free tier: 3M messages/month, 200 connections              │
│  - Only organizers connect (~10-20 concurrent)                │
│  - Server publishes via REST API (ABLY_SERVER_KEY)            │
│  - Browser subscribes via token auth (/api/ably/token)        │
│  - Falls back to 15s polling if Ably is not configured        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│         CLOUDFLARE TURNSTILE (Optional, Free)                │
│  - Bot protection (CAPTCHA alternative, invisible to users)  │
│  - No edge caching (no Cloudflare Worker in this codebase)   │
└─────────────────────────────────────────────────────────────┘
```

## Anti-Cheating Architecture (QR Attendance)

### Tier 1: Signed Scan Certificates
- Each device has an Ed25519 keypair (private in IndexedDB, public registered with server)
- Scan certificates bind the QR token to the device + timestamp + nonce
- Server validates token HMAC against the certificate's `scannedAt` (not sync time)
- Enables offline sync: a scan made in a WiFi dead zone is still valid if synced within 15 minutes (token HMAC validated against `scannedAt`, not sync time)

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
- Supabase Auth (cookie-based sessions via @supabase/ssr)
- Email/password, magic link, and passkey (WebAuthn) support
- PKCE flow for email redirects (server-side code exchange via /api/auth/callback)
- Brute-force lockout: 5 failed attempts → 15-minute account lock. The lock is set via an atomic compare-and-set update (`where: { lockedUntil: null }`) so two concurrent failures cannot both skip the lock-set.
- **Enumeration-safe login**: wrong-password, non-existent email, unconfirmed email, and deactivated account all return an identical generic 401. A dummy `bcrypt.compare` runs on the not-found path to equalize timing so response time does not reveal which emails are registered.
- Cookies: `httpOnly`, `sameSite: lax`, `secure: true` in production

### 2. Authorization (RBAC)
- Three roles: `ADMIN`, `ORGANIZER`, `USER`
- `requireAuth(minimumRole)` on every API route
- Account status re-checked from DB (cached 30s) — suspended = instant lockout
- Cache invalidated on role/status change
- Maintenance mode blocks non-admins
- Admin-only overrides (organizers cannot create manual attendance entries)
- Admin-only delegation toggle (organizers can toggle on their own events)

### 3. Input Validation
- Zod schemas on every API input
- Event time validation: timeOut must be after scheduledAt, before endsAt
- Strict file extension + MIME type validation on uploads
- Program codes validated against `PROGRAM_CODES` set
- Whitelist pagination capped at 500 per page (for override dropdowns)

### 4. CSRF Defense
- Origin/Referer check in middleware (proxy.ts) for POST/PATCH/PUT/DELETE
- Cron routes (`/api/cron/*`) exempt from CSRF (authenticated via CRON_SECRET)
- SameSite=Lax cookies (primary defense)
- Port-insensitive hostname comparison (handles gateway port differences)

### 5. Rate Limiting
- Per-IP for unauthenticated endpoints (login, register, forgot-password)
- Per-account for authenticated endpoints (100/min default)
- Scan endpoint: 30/min per account (not IP — correct for shared WiFi)
- **Admin mutations** (account create/delete): 20/min per admin — prevents admin-driven DoS
- **Whitelist import** (JSON, up to 5000 rows): 3/min per organizer
- **Whitelist file upload** (Excel/PDF/DOCX, up to 10MB): 5/min per organizer
- **Passkey registration** (options + verify): 10/min per account
- **Sensitive presets fail closed** on Upstash error (login, register, otp, passkeyVerify, passkeyRegister, passkeyAccount, loginAccount, adminMutation, whitelistImport, whitelistImportFile) — an attacker cannot DDoS the limiter to bypass brute-force protection
- In-memory fallback Map is **LRU-capped at 10,000 keys** to prevent memory exhaustion under IP rotation

### 6. Cryptography
- HMAC-SHA256 for QR token signing
- Ed25519 for scan certificate signatures (Web Crypto API on client, Node crypto on server)
- bcrypt (cost 12) for password hashing
- Timing-safe comparisons for all HMAC verifications
- Device key fingerprint recomputed server-side (client can't fake it)

### 7. Database Security
- Row-Level Security (RLS) on all 11 tables (Supabase)
- Guard trigger on `accounts` prevents self-escalation via REST API
- Service role bypasses RLS (used by the Next.js backend)
- CHECK constraints on all enum-like columns

### 8. HTTP Security Headers
- Content-Security-Policy (no `unsafe-eval`, `connect-src: self + *.ably.io + *.ably.net`)
- X-Frame-Options (DENY in prod, SAMEORIGIN in dev)
- X-Content-Type-Options: nosniff
- Strict-Transport-Security (HSTS with preload)
- Permissions-Policy (camera=self, microphone=(), geolocation=())
- X-XSS-Protection: 0 (modern browsers use CSP)

### 9. Session Security
- 30-minute inactivity timeout (auto-logout with warning at 25 min)
- Account lookup cached 30s (in-memory, per serverless instance)
- Cache invalidated on admin role/status changes
- Realtime password validation checklist on registration + password reset forms

### 10. File Upload Security
- exceljs (replaces xlsx — prototype pollution CVE)
- pdfjs-dist (replaces pdf-parse — DOMMatrix dependency)
- File size limit (10MB via Caddyfile)
- Strict file type validation (xlsx, xls, pdf, docx, csv only)

## Realtime Architecture

### Ably (Managed Realtime)
- Server publishes attendance events via Ably REST API (`ABLY_SERVER_KEY`)
- Browser subscribes via Ably SDK with token authentication (`/api/ably/token` endpoint signs TokenRequests server-side using the SDK's `createTokenRequest`)
- **Event visibility is enforced on the token route** — the same rule as `GET /api/events` (open-to-all OR exact program+section for students; program-wide or owner for organizers; admin bypass). A student cannot subscribe to another section's realtime channel. This closes a BOLA/API#1 vector that would have exposed other students' full name, student ID, program, and section.
- Only organizers connect (students don't need realtime)
- Falls back to 15s polling if Ably is not configured
- CSP allows `*.ably.io` (REST) and `*.ably.net` (WebSocket)

## Performance Optimizations

### Caching
- Account cache (30s TTL) — eliminates 1 DB query per request
- Maintenance mode cache (10s TTL) with stampede guard
- Browser caching via `Cache-Control: stale-while-revalidate` on all GET routes

### Polling
- Notifications: 60s interval (was 30s)
- Attendance: disabled when Ably connected, 15s fallback (was 4s)
- Event secret: 15s interval only when event is upcoming

### Database
- Batch whitelist import (`createMany` instead of sequential upserts)
- Parallel queries via `Promise.all` on dashboard and events routes
- 40 indexes covering all major query patterns
- PgBouncer connection pooling (Supabase)
- **Profile stats collapsed from 3 queries to 1** (`/api/profile/stats`) — the My-Attendance chart, scope breakdown, and streak are derived from a single `findMany` with JS bucketing, saving 2 DB round-trips per page load
- **TOCTOU-safe cooldown enforcement** — profile and password cooldowns use conditional `updateMany` (where `lastChangedAt` null OR lt cutoff) so concurrent requests cannot both pass the read-only check
- **Stable P2002 detection** via `isUniqueConstraintError(e)` (Prisma error code, not string match) on scan, override, and register routes

## Testing

```bash
bun run test
```

| File | Tests | Coverage |
|------|-------|----------|
| `auth.test.ts` | 15 | Password hashing, HMAC |
| `qr-token.test.ts` | 37 | v8 token generation, validation, sub-frame liveness |
| `scan-certificate.test.ts` | 21 | Certificate creation, canonicalization, idempotency |
| `scan-flow.integration.test.ts` | 24 | Full end-to-end scan flow, anti-cheat simulations |
| `validation.test.ts` | 39 | Zod schemas, event time validation |
| `password-strength.test.ts` | 34 | Password scoring |
| `section-validation.test.ts` | 42 | Year/section consistency |
| `event-visibility.test.ts` | 32 | Strict event filtering |
| `cooldown.test.ts` | 21 | 30-day cooldown logic + TOCTOU-safe cutoff helper |

## Database Schema

### Models
1. **Account** — users (admin, organizer, student)
2. **AuthorizedStudent** — pre-approved student whitelist
3. **VerificationToken** — verification tokens
4. **RefreshToken** — rotating session tokens (legacy)
5. **Event** — attendance events with program/section targeting + time-out windows
6. **EventAttendance** — check-in records with certificate fields
7. **AttendanceOverride** — manual check-ins (admin-only, idempotent)
8. **Notification** — user notifications
9. **AuditLog** — immutable audit trail
10. **DeviceKey** — Ed25519 public keys per device
11. **Setting** — key-value settings (maintenance mode, etc.)

### Key Indexes
- `events`: `[status, scheduledAt]`, `[targetProgram, targetSection, status]`
- `event_attendance`: `[accountId, scannedAt]`, `[eventId, scannedAt]`, `[deviceFingerprint]`
- `notifications`: `[accountId, createdAt]`, `[accountId, readAt]`
- `audit_logs`: `[actorId, createdAt]`, `[action, createdAt]`, `[targetType, targetId, createdAt]`
- `device_keys`: `[fingerprint]` (unique), `[accountId, revokedAt]`

## Infrastructure ($0/month)

| Service | Plan | Purpose | Limit |
|---------|------|---------|-------|
| Vercel | Hobby | Next.js hosting + API | 100GB bandwidth/mo |
| Supabase | Free | PostgreSQL + Auth | 500MB DB, 50k MAU |
| Ably | Free | Realtime attendance | 3M messages/mo, 200 conn |
| Cloudflare Turnstile | Free | Optional bot protection (CAPTCHA alternative) | — |

**Scalability:** ~500 sustained concurrent scanning users / ~1,300 peak burst / ~1,300 MAU on free tiers. The first hard wall is Ably's 1,000 msg/s peak (degrades gracefully — attendance recording continues). See [CAPACITY-ASSESSMENT.md](./CAPACITY-ASSESSMENT.md) for the full analysis.
