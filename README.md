# Nexus Gate

**Attendance System with Anti-Cheating QR Codes**

Nexus Gate is a production-ready attendance tracking system designed for educational institutions. It uses cryptographic QR tokens, Ed25519 signed scan certificates, and multi-frame liveness detection to prevent cheating - even on unreliable campus WiFi.

## Features

- **Anti-Cheating QR Attendance**: 2 FPS rotating QR codes with sub-frame HMACs. Students must capture 3+ consecutive frames - a single photo is rejected.
- **Offline-First (15-min window)**: Scans are saved to `localStorage` and auto-sync when reconnected. A scan made in a WiFi dead zone is still valid if synced within 15 minutes. The token HMAC is validated against the scan's `scannedAt` timestamp, not server sync time. GET endpoints use a client-side stale-while-revalidate cache (`src/lib/api-cache.ts`) so the UI renders instantly from cache when offline, then revalidates in the background.
- **Signed Scan Certificates**: Each scan is cryptographically bound to the student's device via Ed25519 signatures. Queue tampering breaks the signature and is rejected. The signing device key must belong to the submitting account — a certificate signed by one student's device cannot be replayed under another's session (proxy-scanning defense).
- **One-Attempt Policy**: After the first successful scan, all subsequent attempts return "already scanned." Enforced atomically via a unique constraint on `(eventId, accountId)` with stable Prisma P2002 detection.
- **Strict Event Visibility**: Students see only events for their exact course + section (or open-to-all events). The same rule is enforced on the Ably token route so a student cannot subscribe to another section's realtime channel. Organizers always see events they own (plus v8-visible events), so an organizer's own section-specific event is never hidden from them.
- **Program-Scoped Organizers**: Organizers are limited to their own program scope (e.g. a BSIT organizer can only create BSIT-scoped academic events; department-wide events are admin-only). Delegation is program-based: an organizer may project another organizer's QR only for program-wide events in their own program.
- **Secure File Import**: The whitelist import runs a 5-layer defense-in-depth checkpoint (`src/lib/file-security.ts`) that validates the file's actual content (magic-byte sniff), not just the client-provided filename/MIME. Blocks renamed executables (`sample.exe` → `sample.docx`), masked double extensions, macro-enabled Office files (`.xlsm`/`.xlsb`), and content/extension mismatches before any parser runs.
- **Sorted, Scope-Restricted Exports**: Attendance CSV exports are sorted by program, year, section, then student ID (intuitive roster grouping), with PHT-formatted timestamps and a UTF-8 BOM for Excel. Organizers only ever receive their own program's rows (defense-in-depth row filter), even on department-wide events.
- **Admin Batch Operations**: Admins can activate, suspend, or re-role many accounts in one confirmed action. Bulk hard-delete is architecturally impossible (no DELETE method on the batch route) — an accidental or compromised batch call can never wipe the account table. Guards: 200-id cap, last-admin protection, self-action block.
- **30-Day Cooldowns**: Profile updates and password changes are limited to once every 30 days. Enforced via a TOCTOU-safe compare-and-set database update - concurrent requests cannot halve the cooldown.
- **Server-Side Password Strength**: Passwords are scored server-side - clients can't bypass the strength requirement.
- **Realtime Password Validation**: Registration form shows a live strength meter + missing requirements as the user types.
- **Session Timeout**: Auto-logout after 30 minutes of inactivity with a warning at 25 minutes.
- **Brute-Force Lockout**: Account locks for 15 minutes after 5 failed login attempts. The lock is set via an atomic compare-and-set update so concurrent failures cannot both skip the lock.
- **Enumeration-Safe Login**: Login returns an identical generic 401 for wrong-password, non-existent email, unconfirmed email, and deactivated account. A dummy bcrypt compare equalizes timing on the not-found path so response time does not reveal which emails are registered.
- **Offline-First Signed Overrides (v16)**: Organizers (own events) and admins can mark students present manually — even offline. Each entry is an Ed25519-signed override certificate bound to the organizer's device; the signed creation timestamp must fall within the event's live window, must sync within 24h, and every row records device fingerprint + clock drift + sync delay + an offline flag for forensic review. Tampered queue items break the signature and are rejected. Eligibility is whitelist-enforced, deactivated accounts are rejected, and certificates signed by another account's device are refused.
- **Role-Based Access**: Admin, Organizer, and Student roles with server-enforced authorization.
- **Secure "Remember Me"**: Opt-in 30-day session persistence on the sign-in form (default off). Session cookies are always HttpOnly + SameSite=Lax; unchecked means a browser-session cookie that dies when the browser closes. ADMIN accounts are force session-scoped, the 30-minute inactivity logout always applies, and sign-out revokes both the server session and the persistence marker. This replaces `@supabase/ssr`'s 400-day JS-readable default cookies with a bounded, explicit policy.
- **Hybrid Passkey Auth**: WebAuthn with `userVerification: "required"` end-to-end (possession + biometric). Sync-fabric-enabled (`residentKey: "preferred"`) so a passkey registered on a phone is usable on a PC/tablet via iCloud Keychain / Google Password Manager or the cross-device QR flow. Credential reuse across accounts is rejected. Unsupported browsers get a clear fallback message, not a dead button.
- **Privacy-Preserving Visit Analytics**: Page views are recorded with the public IP HMAC-hashed (daily-rotating secret) - the raw IP is NEVER stored. The token identifies "same visitor on the same day" only; cross-day correlation is impossible. Admin dashboard shows 7-day unique visitors + total visits + top routes. Admin-only read access (`requireAuth("ADMIN")`); no IDOR surface (no object-id params).
- **Tiered Rate Limiting**: Per-IP for unauthenticated endpoints, per-account for authenticated, plus dedicated presets for destructive admin mutations (20/min), whitelist imports (3/min), file uploads (5/min), and passkey registration (10/min). Sensitive presets fail closed on limiter error.

## Tech Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript 5 (strict mode)
- **Database**: Prisma ORM (SQLite dev / TiDB Serverless prod) — MySQL-compatible. Supabase is used for **auth only** (sessions/JWT/email); app data lives in TiDB. See [TiDB Data Protection](./docs/tidb-data-protection.md) for how row-level access is enforced at the app layer (TiDB has no built-in RLS).
- **UI**: Tailwind CSS 4 + shadcn/ui (New York)
- **State**: TanStack Query (server state)
- **Auth**: Supabase Auth (email/password + magic link + passkey)
- **Realtime**: Ably (managed realtime, free tier: 3M messages/month)
- **File Parsing**: exceljs (Excel), pdfjs-dist (PDF), mammoth (DOCX), papaparse (CSV)
- **Testing**: Vitest (530 unit + integration tests across 4 suites), Selenium-style E2E browser suite (agent-browser), endpoint authz scanner

## Quick Start

```bash
# Install dependencies
bun install

# Set up environment
cp example.env .env
# Edit .env with your values (DATABASE_URL, Supabase auth keys, ABLY_SERVER_KEY)

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
prompts - never ships with hardcoded credentials):

```bash
bun run bootstrap:admin
```

Set `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, and
`BOOTSTRAP_ADMIN_NAME` in `.env` first (see `example.env`), or pass them
inline. The migration `0001_init.sql` also inserts a seed admin
(`admin@ctu.edu.ph`) - change its password immediately on first login.

## Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start dev server (port 3000, SQLite schema) |
| `bun run lint` | Run ESLint |
| `bun run test` | Run all unit + edge-case tests (Vitest) |
| `bun run test:watch` | Run tests in watch mode |
| `bun run test:e2e` | Run Selenium-style E2E browser suite (agent-browser) |
| `bun run test:scan` | Run endpoint authz scanner (all 54 routes) |
| `bun run test:all` | Run the full pyramid: unit + endpoint scan + E2E |
| `bun run bootstrap:admin` | Create the first admin account |
| `bun run seed:events` | Seed test events for development |
| `bun run db:push` | Push Prisma schema (active provider) |
| `bun run db:push:sqlite` | Push Prisma schema (SQLite dev) |
| `bun run db:push:tidb` | Push Prisma schema (TiDB prod) — run from an **up-to-date checkout** |
| `bun run db:verify:tidb` | **Verify** the live TiDB DB matches the current schema (exit 2 on drift) |
| `bun run db:diagnose:tidb` | Check **every** configured MySQL url (env + .env) for drift — use when verify says IN SYNC but production still returns `DB_SCHEMA_DRIFT` |
| `bun run db:generate:sqlite` | Regenerate Prisma client (SQLite) |
| `bun run db:generate:tidb` | Regenerate Prisma client (TiDB) |

## Documentation

- [Deployment Guide](./DEPLOYMENT-GUIDE.md) - Step-by-step TiDB + Supabase-auth + Vercel setup
- [Architecture & Security](./ARCHITECTURE-SECURITY.md) - System diagram + security layers
- [Full Documentation](./DOCUMENTATION.md) - Comprehensive feature + API reference
- [TiDB Data Protection](./docs/tidb-data-protection.md) - How row-level access is enforced without Postgres RLS
- [Capacity Assessment](./CAPACITY-ASSESSMENT.md) - Scalability analysis + resolved bottlenecks

## Testing

```bash
# Run all unit + edge-case tests
bun run test

# Run the full pyramid (unit + endpoint scan + E2E)
bun run test:all

# Run specific test file
bunx vitest run tests/lib/qr-token.test.ts
```

### Test Coverage

All tests live in `tests/unit/` (pure-logic unit tests), `tests/integration/` (data-layer integration tests), and `tests/e2e/` (browser + endpoint scanner), kept separate from production source.

| File | Tests | What it covers |
|------|-------|----------------|
| `tests/unit/event-visibility.test.ts` | 15 | v8 visibility predicate (open-to-all, program-wide, exact section match), organizer rule, Prisma WHERE fragment, profile-completion check |
| `tests/unit/file-security.test.ts` | 17 | 5-layer upload checkpoint: magic-byte sniff, masked extensions, renamed executables, macro files, MIME mismatch, boundary cases |
| `tests/integration/export.test.ts` | 3 | Export sorting (program/year/section), organizer program-scope restriction, cross-program attendee exclusion |
| `tests/integration/batch.test.ts` | 5 | Batch safety guards: self-action detection, last-admin guard, 200-id cap, suspend/activate/setRole |
| `auth.test.ts` | 6 | Password hashing, HMAC |
| `qr-token.test.ts` | 46 | v8 token generation, validation, sub-frame liveness |
| `qr-token-edge-cases.test.ts` | 27 | Drift boundaries (±1/±2), subFrame range, malformed payloads, liveness gaps |
| `validation.test.ts` | 48 | Zod schemas, event time validation |
| `validation-boundaries.test.ts` | 38 | Password length/char-class, studentId range, email max, section format, agreeToTerms |
| `forgot-password-redirect.test.ts` | 18 | Open-redirect defense (protocol-relative URLs, cross-origin, fail-closed) |
| `scan-certificate-hardening.test.ts` | 20 | Canonicalization tamper detection, idempotency binding, timestamp validation |
| `timing-safe.test.ts` | 9 | Constant-time hex compare, malformed-input rejection, no-throw contract |
| `analytics-authz.test.ts` | 6 | Admin-only RBAC gate + IDOR surface invariants |
| `passkey-availability.test.ts` | 7 | Browser support detection, secure-context check, fallback messages |
| `rxdb-snapshot.test.ts` | 7 | RxDB snapshot serialization contract + SSR guard |
| `scan-flow.integration.test.ts` | 28 | Full end-to-end scan flow, anti-cheat simulations |
| `event-visibility.test.ts` | 26 | Strict event filtering |
| `password-strength.test.ts` | 27 | Password scoring |
| `scan-certificate.test.ts` | 21 | Certificate creation, canonicalization, idempotency |
| `event-time.test.ts` | 19 | Event time window validation |
| `cooldown.test.ts` | 21 | 30-day cooldown logic + TOCTOU-safe cutoff helper |
| `pagination.test.ts` | 17 | Pagination schema + helpers |
| `section-validation.test.ts` | 14 | Year/section consistency |
| `ics-export.test.ts` | 12 | ICS calendar export |
| `webauthn-context.test.ts` | 8 | WebAuthn RP ID / origin resolution |
| `passkey-credential.test.ts` | 8 | WebAuthn credential storage |
| `rate-limit.test.ts` | 8 | Aiven Redis + in-memory rate limiter |
| `prisma-errors.test.ts` | 4 | Stable P2002 unique-constraint detection |
| `device-key-server.test.ts` | 4 | Ed25519 device key verification |
| `tests/e2e/run-e2e.sh` | 7 | Selenium-style browser suite (landing, auth dialog, register, FAQ) |
| `tests/e2e/scan-endpoints.sh` | 46 | All 54 routes probed for auth-gating + broken + auth-bypass |

**Total: 530 unit/integration tests + 7 E2E + 46 endpoint scans.**

## Infrastructure ($0/month)

| Service | Plan | Purpose |
|---------|------|---------|
| Vercel | Hobby (free) | Next.js hosting + API routes |
| TiDB | Serverless (free tier) | MySQL-compatible app database |
| Supabase | Free | Auth only (sessions/JWT/email) |
| Ably | Free | Realtime attendance updates (3M messages/mo) |
| Cloudflare Turnstile | Free | Optional bot protection (CAPTCHA alternative) |

## Capacity (free tier)

The hard ceilings are infra limits, not code limits. The code degrades
gracefully - attendance recording survives realtime failure.

| Metric | Estimate | First wall |
|--------|----------|-----------|
| Sustained concurrent scanning users | ~500 | Ably 1,000 msg/s peak |
| Peak burst (class-start) | ~500-1,300 | Ably msg/s + Vercel 10s function cap |
| Monthly active users | ~1,300 | Vercel 100 GB bandwidth/mo |
| Database storage exhaustion | ~6 weeks at 2,000 users | TiDB Serverless free tier |

See [CAPACITY-ASSESSMENT.md](./CAPACITY-ASSESSMENT.md) for the full
back-of-envelope analysis, bottleneck ranking, and upgrade path.

## License

MIT - See [LICENSE](./LICENSE)
