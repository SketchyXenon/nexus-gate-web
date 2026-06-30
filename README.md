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
- **Row-Level Security**: All database tables have strict RLS policies (Supabase).
- **Role-Based Access**: Admin, Organizer, and Student roles with server-enforced authorization.

## Tech Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript 5 (strict mode)
- **Database**: Prisma ORM (SQLite dev / PostgreSQL prod via Supabase)
- **UI**: Tailwind CSS 4 + shadcn/ui (New York)
- **State**: TanStack Query (server) + Zustand (client)
- **Auth**: Custom JWT (email/password) + NextAuth (Google OAuth optional)
- **Realtime**: Socket.io (optional mini-service)
- **Testing**: Vitest (262 tests)

## Quick Start

```bash
# Install dependencies
bun install

# Set up environment
cp example.env .env
# Edit .env with your values

# Create the first admin account
bun run bootstrap:admin

# Push the database schema
bun run db:push

# Start the dev server
bun run dev
```

Open `http://localhost:3000` in your browser.

## Admin Credentials (Dev)

After running `bun run bootstrap:admin`:
- **Email**: `admin@nexusgate.dev`
- **Password**: `AdminPass123!`

## Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start dev server (port 3000) |
| `bun run lint` | Run ESLint |
| `bun run test` | Run all 262 unit + integration tests |
| `bun run test:watch` | Run tests in watch mode |
| `bun run bootstrap:admin` | Create the first admin account |
| `bun run seed:events` | Seed test events for development |
| `bun run db:push` | Push Prisma schema to database |
| `bun run db:generate` | Regenerate Prisma client |

## Documentation

- [Deployment Guide](./DEPLOYMENT-GUIDE.md) — Step-by-step Supabase + Vercel + Caddy setup
- [Environment Variables](./ENV-VARIABLES.md) — Complete env var reference
- [Architecture & Security](./ARCHITECTURE-SECURITY.md) — System diagram + 8 security layers
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
| `auth.test.ts` | 15 | Password hashing, JWT, refresh tokens |
| `qr-token.test.ts` | 37 | v8 token generation, validation, sub-frame liveness |
| `scan-certificate.test.ts` | 21 | Certificate creation, canonicalization, idempotency |
| `scan-flow.integration.test.ts` | 24 | Full end-to-end scan flow, anti-cheat simulations |
| `validation.test.ts` | 39 | Zod schemas, OTP removal verification |
| `password-strength.test.ts` | 34 | Password scoring |
| `section-validation.test.ts` | 42 | Year/section consistency |
| `event-visibility.test.ts` | 32 | Strict event filtering |
| `cooldown.test.ts` | 18 | 30-day cooldown logic |

## License

MIT — See [LICENSE.md](./LICENSE.md)
