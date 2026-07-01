# Nexus Gate — Session Notes

> Consolidated record of the debugging + deployment session (2026-07-01).
> Full raw worklog: [`worklog.md`](./worklog.md)

---

## Session Overview

This session resolved a cascading series of production failures on Vercel
and prepared the project for Render deployment. What started as a single
500 error on `/api/auth/register` turned into a 5-part root-cause hunt —
each fix peeled back one layer to reveal the next issue underneath.

**Final state:** Local + Vercel both functional. Render blueprint ready.

---

## The 5-Part Vercel 500 Saga

### Part 1 — Prisma provider mismatch (`VERCEL-500-FIX`)

**Symptom:** `POST /api/auth/register → 500` on Vercel.

**Root cause:** `prisma/schema.prisma` had `provider = "sqlite"`. SQLite
is file-based and cannot run on Vercel's serverless functions (ephemeral,
read-only filesystem). The first DB call (`db.account.findUnique`) had no
try/catch, so the connection failure became an unhandled 500.

**Secondary issue:** The Supabase migrations use snake_case tables/columns
(`accounts`, `password_hash`), but the Prisma schema used camelCase
(`passwordHash`) with no `@map` annotations. Even after fixing the
provider, Prisma would query non-existent tables.

**Fix:**
- `prisma/schema.prisma` → switched to `provider = "postgresql"` + added
  `@@map`/`@map` to every model/field, cross-referenced against the
  Supabase migration DDL.
- Created `prisma/schema.sqlite.prisma` for local dev (keeps the existing
  local SQLite DB working).
- `package.json` `dev` script generates the SQLite client; Vercel's
  install generates the postgresql client.

---

### Part 2 — Missing Prisma client generation (`VERCEL-500-FIX-PART2`)

**Symptom:** Same 500 persisted. Supabase logs showed successful auth
connections but no query execution.

**Root cause:** Prisma 6+ does NOT auto-generate the client on
`bun install`. There was no `postinstall` hook and no `prisma generate`
in the build script. So on Vercel, `node_modules/.prisma/client` was
stale/missing — every `db.*` call threw before reaching the DB.

**Fix:**
- `package.json` → added `"postinstall": "prisma generate || ..."`
- `package.json` → prepended `prisma generate &&` to the `build` script
- `src/lib/db.ts` → bumped `SCHEMA_CACHE_KEY` to invalidate stale cache

---

### Part 3 — Wrong database credentials (`VERCEL-500-FIX-PART3`)

**Symptom:** New error: `PrismaClientInitializationError` — "Authentication
failed against database server, the provided database credentials for
`postgres` are not valid" (PostgreSQL P1000).

**Root cause:** The `DATABASE_URL` env var on Vercel had the wrong
password — most likely a password with special characters (`@`, `:`, `/`,
`#`, `$`) that were NOT URL-encoded, causing Prisma to parse the
connection string incorrectly.

**Fix (code resilience):**
- `src/lib/api.ts` → added `isDbUnavailableError()` + `dbUnavailable()`
  helpers (returns 503 instead of 500).
- `src/app/api/auth/register/route.ts` + `login/route.ts` → wrapped first
  DB calls in try/catch.
- `src/app/api/health/route.ts` → enhanced with a `hint` field that
  classifies the error (auth failure / timeout / unreachable).

**Fix (operator action):** URL-encode special characters in the password
(`@` → `%40`, etc.) and set `DATABASE_URL` on Vercel.

---

### Part 4 — Supabase pooler + Prisma prepared-statement conflict (`VERCEL-500-FIX-PART4`)

**Symptom:** Registration worked, but `POST /api/auth/login → 503`.
Error: `PrismaClientUnknownRequestError` code `42P05` — "prepared
statement 's0' already exists".

**Root cause:** The `DATABASE_URL` pointed to Supabase's connection pooler
(Supavisor/PgBouncer in transaction mode). PgBouncer routes each query to
a different backend connection. Prisma prepares `s0` on connection A, then
PgBouncer routes the next query to connection B where `s0` already exists
→ PostgreSQL rejects with 42P05. This is intermittent (connection-pooler
roulette), which is why registration got lucky but login didn't.

The previous `isDbUnavailableError()` helper didn't recognize
`PrismaClientUnknownRequestError`, so the existing try/catch re-threw it.

**Fix (code resilience):**
- `src/lib/api.ts` → `isDbUnavailableError()` now also catches
  `PrismaClientUnknownRequestError`. `dbUnavailable()` detects 42P05
  specifically and returns a 503 with `code: "DB_POOLER_CONFLICT"` and a
  hint.
- `src/app/api/auth/login/route.ts` → restructured with a top-level
  try/catch protecting ALL DB calls (not just findUnique).
- `src/app/api/auth/register/route.ts` → same top-level try/catch.
- `src/app/api/health/route.ts` → now runs TWO checks: raw `SELECT 1`
  (connectivity) + `db.setting.count()` (model query using prepared
  statements — catches 42P05 that a raw query misses).

**Fix (operator action):** Add `?pgbouncer=true&connection_limit=1` to
`DATABASE_URL` on Vercel, OR switch to the direct connection (port 5432).

---

### Part 5 — Database trigger blocking backend writes (`VERCEL-500-FIX-PART5`)

**Symptom:** Login 503 — new error: `PrismaClientUnknownRequestError`
code `P0001` — "status column cannot be changed via RLS — use the admin
API". The 42P05 pooler issue was resolved; now a trigger blocked the
write.

**Root cause:** Migration `0005` created a `guard_account_columns()`
BEFORE UPDATE trigger on `accounts` that raises an exception whenever
`status`/`role`/`student_id`/`failed_login_attempts`/`locked_until`/
`password_hash` changes. Its comment claimed "the service role bypasses
RLS, so app writes are unaffected" — but that's FALSE. RLS controls row
visibility; triggers fire on ALL writes regardless of role. So the trigger
blocked Prisma's legitimate updates too.

This is why registration worked but login didn't: register uses INSERT
(trigger is BEFORE UPDATE); login uses UPDATE (status, failedLoginAttempts,
lockedUntil) — all blocked.

**Affected routes (all blocked by the trigger):**
1. `/api/auth/login` (status, failedLoginAttempts, lockedUntil)
2. `/api/auth/passkey/verify` (status, failedLoginAttempts, lockedUntil)
3. `/api/auth/reset-password` (passwordHash)
4. `/api/profile/password` (passwordHash)
5. `/api/accounts/[id]` (role, status)

**Fix:** Created `supabase/migrations/0009_fix_guard_trigger_role_aware.sql`
— rewrites the trigger function to be role-aware: it reads
`current_setting('role', true)` and only enforces the guard for REST API
users (`authenticated`/`anon`). Direct Prisma connections (NULL role) skip
the guard — exactly what migration 0005 intended but failed to implement.

**Operator action:** Apply migration 0009 to Supabase via the SQL Editor.
No Vercel redeploy needed (it's a database change).

---

## Turnstile UX Fix (`TURNSTILE-UX-FIX`)

**Symptom:** The Cloudflare Turnstile challenge appeared on every route,
frustrating users.

**Four problems identified:**
1. `TurnstileGate` wrapped the entire app (login + dashboard) —
   authenticated users saw the challenge on every dashboard load.
2. `verified` state was a plain `useState` — reset on every mount →
   challenge reappeared on every navigation.
3. No error handling — when Turnstile errored (600010 / cdn-cgi 404 on
   Vercel), users were permanently trapped.
4. Used `size: "normal"` (always-visible widget) instead of invisible mode.

**Fixes:**
- `src/app/page.tsx` → gate now wraps ONLY the unauthenticated path.
  Authenticated users go straight to the app shell — never see a challenge.
- `src/components/nexus/turnstile-gate.tsx` → rewritten with:
  - sessionStorage persistence (4-hour grace window) — one challenge per
    browser session instead of one per navigation.
  - 8-second fallback timer + `onError` callback → a "Continue to Nexus
    Gate" button appears if Turnstile doesn't resolve or errors. Users are
    never permanently trapped.
  - `appearance: "execute"` → runs invisibly; interactive challenge only
    shows if Cloudflare flags the visitor.
- Documented that the gate is cosmetic (no server-side token verification);
  real bot protection is the server-side rate limiter.

---

## Render Deployment Setup (`RENDER-DEPLOY-SETUP`, `RENDER-SECRETS-CLARIFICATION`)

**Goal:** Deploy as a Render web service (persistent connection → no
pooler conflict, no cold starts for the Prisma client).

**Created:** `render.yaml` blueprint at repo root — enables one-click
deploy via Render dashboard (New → Blueprint → select repo).

**Key config:**
- `runtime: node`, `plan: free` (upgradable)
- `buildCommand: npm install -g bun && bun install && bun run build`
- `startCommand: node .next/standalone/server.js`
- `healthCheckPath: /api/health` (Render polls this; catches DB issues
  before routing traffic)
- `autoDeploy: true`

**Auth secrets clarification:** The app uses THREE secrets (not `JWT_SECRET`
which isn't used anywhere):
- `NEXTAUTH_SECRET` → NextAuth.js (Google OAuth + sessions)
- `AUTH_SECRET` → custom JWT access tokens (`src/lib/auth.ts`) — ≥32 chars
- `REFRESH_SECRET` → refresh token signing (`src/lib/auth.ts`) — ≥32 chars

These are just random strings (base64 is only the output format of
`openssl rand -base64 32` for safe copy-paste). Generate 3 different
values and paste directly — no further encoding.

**Render advantage over Vercel:** Render keeps a persistent connection, so
Prisma's prepared statements work natively with the direct Supabase
connection. No `?pgbouncer=true` needed — use the direct connection string
(`db.<ref>.supabase.co:5432`).

**Build troubleshooting encountered:** Render initially failed with
"Script not found 'build'" because the web service was created manually
with the wrong root directory (it picked up `mini-services/realtime/
package.json` instead of the root). Fix: use the Blueprint (which has
`rootDir: .`), or set the Root Directory to empty/`.` in the manual
service settings.

---

## Files Changed This Session

| File | Change |
|------|--------|
| `prisma/schema.prisma` | provider sqlite→postgresql, added @map/@@map |
| `prisma/schema.sqlite.prisma` | NEW — local dev SQLite schema |
| `package.json` | postinstall hook, prisma generate in build, dev regenerates sqlite client, db:generate:sqlite + db:push:sqlite scripts |
| `src/lib/db.ts` | bumped SCHEMA_CACHE_KEY to v13 |
| `src/lib/api.ts` | added isDbUnavailableError() + dbUnavailable() helpers (detects PrismaClientInitializationError, RustPanicError, UnknownRequestError; detects 42P05 pooler conflict + P0001 trigger errors) |
| `src/app/api/auth/register/route.ts` | top-level try/catch → DB errors return 503 not 500 |
| `src/app/api/auth/login/route.ts` | top-level try/catch protecting all DB calls |
| `src/app/api/health/route.ts` | two-stage check (connectivity + model query) with classified hints |
| `src/app/page.tsx` | TurnstileGate wraps only unauthenticated path |
| `src/components/nexus/turnstile-gate.tsx` | rewritten: sessionStorage persistence, graceful degradation fallback, invisible appearance |
| `supabase/migrations/0009_fix_guard_trigger_role_aware.sql` | NEW — role-aware guard trigger (fixes login/password/admin writes) |
| `render.yaml` | NEW — Render blueprint for one-click deploy |

---

## Deployment Status

| Environment | Status |
|-------------|--------|
| **Local dev** (SQLite) | ✅ Fully functional — register 201, login 401, health 200 |
| **Vercel** | ✅ Functional after applying Parts 1–5 + migration 0009 |
| **Render** | 🟡 Blueprint ready — user deploying (resolved root-dir issue) |

---

## Key Lessons

1. **Prisma + Vercel serverless + Supabase pooler** is a fragile
   combination. The direct connection (port 5432) avoids the pooler
   entirely, but Vercel serverless may exhaust connections under load.
   Render's persistent connection is the cleaner architecture.

2. **RLS and triggers are different layers.** RLS controls row visibility;
   triggers fire on all writes. A trigger that "protects against RLS
   writes" must check `current_setting('role', true)` — it cannot rely on
   the service role "bypassing" it, because triggers don't check RLS.

3. **Prisma 6+ needs explicit `prisma generate`.** The `postinstall` hook
   is mandatory for any deployment platform that runs `install` without
   running your build script first.

4. **A bot-protection gate that wraps the whole app is an anti-pattern.**
   Gate only the unauthenticated entry points, persist verification, and
   always provide a graceful fallback — a misconfigured third-party widget
   should never be able to lock users out of the app.

5. **The `/api/health` endpoint with classified hints was the single most
   valuable debugging tool.** Each layer of the 500 saga was diagnosed by
   hitting `/api/health` and reading the `hint` field — it told us exactly
   what was wrong without needing to register/login repeatedly.
