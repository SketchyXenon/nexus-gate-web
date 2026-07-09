# Nexus Gate

**Attendance System with Anti-Cheating QR Codes**

Nexus Gate is a production-ready attendance tracking system designed for educational institutions. It uses cryptographic QR tokens, Ed25519 signed scan certificates, and multi-frame liveness detection to prevent cheating — even on unreliable campus WiFi.

## Features

- **Anti-Cheating QR Attendance**: 2 FPS rotating QR codes with sub-frame HMACs. Students must capture 3+ consecutive frames — a single photo is rejected.
- **Offline-First**: Scans are saved locally and auto-sync when reconnected. A scan made at 9 AM that syncs at 2 PM is still valid.
- **Signed Scan Certificates**: Each scan is cryptographically bound to the student's device via Ed25519 signatures. Queue tampering is detected.
- **One-Attempt Policy**: After the first successful scan, all subsequent attempts return "already scanned."
- **Strict Event Visibility**: Students see only events for their exact course + section (or open-to-all events).
- **30-Day Cooldowns**: Profile updates and password changes are limited to once every 30 days.
- **Server-Side Password Strength**: Passwords are scored server-side — clients can't bypass the strength requirement.
- **Realtime Password Validation**: Registration form shows a live checklist of password requirements as the user types.
- **Session Timeout**: Auto-logout after 30 minutes of inactivity with a warning at 25 minutes.
- **Brute-Force Lockout**: Account locks for 15 minutes after 5 failed login attempts.
- **Admin-Only Overrides**: Manual attendance overrides restricted to administrators for integrity.
- **Role-Based Access**: Admin, Organizer, and Student roles with server-enforced authorization.

## Tech Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript 5 (strict mode)
- **Database**: Prisma ORM (SQLite dev / PostgreSQL prod via Supabase)
- **UI**: Tailwind CSS 4 + shadcn/ui (New York)
- **State**: TanStack Query (server) + Zustand (client)
- **Auth**: Supabase Auth (email/password + Google OAuth + magic link + passkey)
- **Realtime**: Ably (managed realtime, free tier: 3M messages/month)
- **File Parsing**: exceljs (Excel), pdfjs-dist (PDF), mammoth (DOCX), papaparse (CSV)
- **Testing**: Vitest (250+ tests)

## Quick Start

```bash
# Install dependencies
bun install

# Set up environment
cp example.env .env
# Edit .env with your values (DATABASE_URL, Supabase keys, Ably keys)

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
| `bun run dev` | Start dev server (port 3000) |
| `bun run lint` | Run ESLint |
| `bun run test` | Run all unit + integration tests |
| `bun run test:watch` | Run tests in watch mode |
| `bun run bootstrap:admin` | Create the first admin account |
| `bun run seed:events` | Seed test events for development |
| `bun run db:push` | Push Prisma schema to database |
| `bun run db:generate` | Regenerate Prisma client |

## Documentation

- [Deployment Guide](./DEPLOYMENT-GUIDE.md) — Step-by-step Supabase + Vercel setup
- [Architecture & Security](./ARCHITECTURE-SECURITY.md) — System diagram + security layers
- [Full Documentation](./DOCUMENTATION.md) — Comprehensive feature + API reference

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
| `auth.test.ts` | 15 | Password hashing, HMAC |
| `qr-token.test.ts` | 37 | v8 token generation, validation, sub-frame liveness |
| `scan-certificate.test.ts` | 21 | Certificate creation, canonicalization, idempotency |
| `scan-flow.integration.test.ts` | 24 | Full end-to-end scan flow, anti-cheat simulations |
| `validation.test.ts` | 39 | Zod schemas, event time validation |
| `password-strength.test.ts` | 34 | Password scoring |
| `section-validation.test.ts` | 42 | Year/section consistency |
| `event-visibility.test.ts` | 32 | Strict event filtering |
| `cooldown.test.ts` | 18 | 30-day cooldown logic |

## Infrastructure ($0/month)

| Service | Plan | Purpose |
|---------|------|---------|
| Vercel | Hobby (free) | Next.js hosting + API routes |
| Supabase | Free | PostgreSQL database + Auth |
| Ably | Free | Realtime attendance updates (3M messages/mo) |
| Cloudflare | Free | Optional edge caching + DDoS protection |

## License

MIT — See [LICENSE](./LICENSE)
