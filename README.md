# Nexus Gate

**Attendance System with Anti-Cheating QR Codes**

Nexus Gate is a production-ready attendance tracking system designed for educational institutions. It uses cryptographic QR tokens, Ed25519 signed scan certificates, and multi-frame liveness detection to prevent cheating — even on unreliable campus WiFi.

## Features

- **Anti-Cheating QR Attendance**: 2 FPS rotating QR codes with sub-frame HMACs. Students must capture 3+ consecutive frames — a single photo is rejected.
- **Offline-First (15-min window)**: Scans are saved to localStorage and auto-sync when reconnected. A scan made in a WiFi dead zone is still valid if synced within 15 minutes. The token HMAC is validated against the scan's `scannedAt` timestamp, not server sync time.
- **Signed Scan Certificates**: Each scan is cryptographically bound to the student's device via Ed25519 signatures. Queue tampering breaks the signature and is rejected.
- **One-Attempt Policy**: After the first successful scan, all subsequent attempts return "already scanned." Enforced atomically via a unique constraint on `(eventId, accountId)`.
- **Strict Event Visibility**: Students see only events for their exact course + section (or open-to-all events).
- **30-Day Cooldowns**: Profile updates and password changes are limited to once every 30 days.
- **Server-Side Password Strength**: Passwords are scored server-side — clients can't bypass the strength requirement.
- **Realtime Password Validation**: Registration form shows a live strength meter + missing requirements as the user types.
- **Session Timeout**: Auto-logout after 30 minutes of inactivity with a warning at 25 minutes.
- **Brute-Force Lockout**: Account locks for 15 minutes after 5 failed login attempts.
- **Admin-Only Overrides**: Manual attendance overrides restricted to administrators for integrity.
- **Role-Based Access**: Admin, Organizer, and Student roles with server-enforced authorization.

## Tech Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript 5 (strict mode)
- **Database**: Prisma ORM (SQLite dev / PostgreSQL prod via Supabase)
- **UI**: Tailwind CSS 4 + shadcn/ui (New York)
- **State**: TanStack Query (server state)
- **Auth**: Supabase Auth (email/password + magic link + passkey)
- **Realtime**: Ably (managed realtime, free tier: 3M messages/month)
- **File Parsing**: exceljs (Excel), pdfjs-dist (PDF), mammoth (DOCX), papaparse (CSV)
- **Testing**: Vitest (361 tests)

## Quick Start

```bash
# Install dependencies
bun install

# Set up environment
cp example.env .env
# Edit .env with your values (DATABASE_URL, Supabase keys, ABLY_SERVER_KEY)

# Create the first admin account
bun run bootstrap:admin

# Push the database schema
bun run db:push

# Start the dev server
bun run dev
```

Open `http://localhost:3000` in your browser.

## Admin Credentials (Dev)

Create your own admin account via the bootstrap script (uses env vars or
prompts — never ships with hardcoded credentials):

```bash
bun run bootstrap:admin
```

Set `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, and
`BOOTSTRAP_ADMIN_NAME` in `.env` first (see `example.env`), or pass them
inline. The migration `0001_init.sql` also inserts a seed admin
(`admin@ctu.edu.ph`) — change its password immediately on first login.

## Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start dev server (port 3000, SQLite schema) |
| `bun run lint` | Run ESLint |
| `bun run test` | Run all unit + integration tests |
| `bun run test:watch` | Run tests in watch mode |
| `bun run bootstrap:admin` | Create the first admin account |
| `bun run seed:events` | Seed test events for development |
| `bun run db:push` | Push Prisma schema (Postgres prod) |
| `bun run db:push:sqlite` | Push Prisma schema (SQLite dev) |
| `bun run db:generate` | Regenerate Prisma client (Postgres) |
| `bun run db:generate:sqlite` | Regenerate Prisma client (SQLite) |

## Documentation

- [Deployment Guide](./DEPLOYMENT-GUIDE.md) — Step-by-step Supabase + Vercel setup
- [Architecture & Security](./ARCHITECTURE-SECURITY.md) — System diagram + security layers
- [Full Documentation](./DOCUMENTATION.md) — Comprehensive feature + API reference
- [Capacity Assessment](./CAPACITY-ASSESSMENT.md) — Scalability analysis + resolved bottlenecks

## Testing

```bash
# Run all tests
bun run test

# Run specific test file
bunx vitest run src/lib/qr-token.test.ts
```

### Test Coverage

| File | Tests | What it covers |
|------|-------|----------------|
| `auth.test.ts` | 6 | Password hashing, HMAC |
| `qr-token.test.ts` | 46 | v8 token generation, validation, sub-frame liveness |
| `validation.test.ts` | 48 | Zod schemas, event time validation |
| `scan-flow.integration.test.ts` | 28 | Full end-to-end scan flow, anti-cheat simulations |
| `event-visibility.test.ts` | 26 | Strict event filtering |
| `password-strength.test.ts` | 27 | Password scoring |
| `scan-certificate.test.ts` | 21 | Certificate creation, canonicalization, idempotency |
| `event-time.test.ts` | 19 | Event time window validation |
| `cooldown.test.ts` | 18 | 30-day cooldown logic |
| `pagination.test.ts` | 17 | Pagination schema + helpers |
| `section-validation.test.ts` | 14 | Year/section consistency |
| `ics-export.test.ts` | 12 | ICS calendar export |
| `ably/token/route.test.ts` | 10 | Token signing, key parsing, spec compliance |
| `webauthn-context.test.ts` | 8 | WebAuthn React context |
| `passkey-credential.test.ts` | 8 | WebAuthn credential storage |
| `rate-limit.test.ts` | 8 | Upstash + in-memory rate limiter |
| `device-key-server.test.ts` | 4 | Ed25519 device key verification |

## Infrastructure ($0/month)

| Service | Plan | Purpose |
|---------|------|---------|
| Vercel | Hobby (free) | Next.js hosting + API routes |
| Supabase | Free | PostgreSQL database + Auth |
| Ably | Free | Realtime attendance updates (3M messages/mo) |
| Cloudflare Turnstile | Free | Optional bot protection (CAPTCHA alternative) |

## License

MIT — See [LICENSE](./LICENSE)
