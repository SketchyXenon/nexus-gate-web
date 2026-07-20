# Nexus Gate — Capacity Assessment Report

> **STATUS UPDATE (2026-07-15):** All 4 code-level bottlenecks listed below
> have been **RESOLVED**. The capacity figures (platform tiers, DB growth,
> bandwidth ceilings) remain accurate. Only the code-level items are stale.
> See the "Resolved Bottlenecks" section at the bottom for details.
>
> Comprehensive analysis of estimated concurrent-user capacity, bottlenecks, and
> recommendations. Source: 4 parallel subagent analyses (Tasks CAP-A through CAP-D),
> full worklog in `/home/z/my-project/worklog.md`.

---

## Executive Summary

| Metric                                               | Estimate                                                                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Realistic sustained concurrent users (free tier)** | **~500 users**                                                                                                                     |
| **Peak burst concurrent users (free tier)**          | **~500–1,300 users** (Ably msg/s ceiling)                                                                                          |
| **Hard ceiling platform**                            | **Ably Free** (1,000 msg/s peak + 3M msg/mo)                                                                                       |
| **First code-level bottleneck**                      | ~~`/api/auth/passkey/login-verify` (N-row scan)~~ **RESOLVED** — now O(log N) via indexed `passkey_credential_id`                  |
| **First DB-level bottleneck**                        | ~~`cron/event-reminders` N×M loop~~ **RESOLVED** — now bulk-fetch + `createMany`. `event_attendance` storage growth still applies. |
| **Storage exhaustion (Supabase Free 500MB)**         | **~6 weeks** at 2000 users / 200 events / 50% attendance                                                                           |
| **Bandwidth exhaustion (Vercel Free 100GB)**         | **~1,300 MAU**                                                                                                                     |

**Bottom line**: The app is well-architected for a single school (up to ~500 concurrent
users on free tiers). Beyond that, Ably's message peak ceiling and Vercel's bandwidth
cap are the first two walls. All code-level bottlenecks (passkey login, whitelist
pagination, event-attendance pagination, cron N+1) have been fixed, and a second
round of hardening (enumeration-safe login, Ably channel BOLA fix, TOCTOU-safe
cooldowns, LRU-capped rate limiter, dedicated admin/import rate limits) has raised
the _effective_ capacity by closing code-level ceilings that would have hit before
the infra ceilings. See "Resolved Bottlenecks" + "Second-Round Hardening" below.

---

## 1. Per-User Load Model

Assumptions used across all analyses:

| Metric                                  | Estimate     | Rationale                                    |
| --------------------------------------- | ------------ | -------------------------------------------- |
| Scans per student per day               | 5            | ~5 class periods/day                         |
| Page views per student per day          | 5            | Login, dashboard, scan, results, logout      |
| Avg page payload                        | ~500 KB      | HTML + JS + CSS + fonts + SVG icons          |
| Concurrent organizers per event channel | 10 (peak 50) | Faculty/admin viewing live attendance        |
| API requests per scan                   | 1            | POST `/api/attendance` + 1 Ably REST publish |
| Errors per session                      | 0.1%         | Conservative production rate                 |

---

## 2. Platform Tier Limits (as of 2026)

### Vercel Hobby (Free)

| Limit                 | Value          | Break-point                           |
| --------------------- | -------------- | ------------------------------------- |
| Function execution    | 10s (Pro: 60s) | ~1,500 users (under DB contention)    |
| Bandwidth             | 100 GB/mo      | **~1,300 MAU**                        |
| Cron jobs             | 2              | Saturated (event-reminders + cleanup) |
| Concurrent executions | Auto-scaled    | Not the first ceiling                 |

### Supabase Free

| Limit              | Value      | Break-point                                          |
| ------------------ | ---------- | ---------------------------------------------------- |
| Database size      | 500 MB     | **~6 weeks** at 2000 users (event_attendance growth) |
| Auth users         | 50,000 MAU | Not a constraint (2000 ≪ 50k)                        |
| Pooler connections | 200        | ~3,000 users (burst of ~200 Vercel instances)        |
| Direct connections | 60         | Only used by Prisma migrations (not runtime)         |

### Ably Free

| Limit                  | Value     | Break-point                                     |
| ---------------------- | --------- | ----------------------------------------------- |
| Messages/month         | 3M        | ~600 users (peak fanout) / ~2,000 (mean fanout) |
| **Peak messages/sec**  | **1,000** | **~500 users** (50 organizers × 30s scan burst) |
| Concurrent connections | 200       | Not a constraint (organizers only)              |

### Sentry Developer (Free)

| Limit                    | Value      | Break-point                                   |
| ------------------------ | ---------- | --------------------------------------------- |
| Errors                   | 5,000/mo   | ~1,500 users (at 0.1% error rate)             |
| **Replays**              | **100/mo** | **<100 users** (replaysOnErrorSampleRate=1.0) |
| Performance transactions | 50,000/mo  | ~2,200 users (tight at current sample rates)  |

---

## 3. Hard Ceiling Ranking (lowest break-point first)

| Rank  | Platform / Limit               | Break-point                       | Failure mode                                                                              |
| ----- | ------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------- |
| **1** | **Ably — 1,000 msg/s peak**    | **~500 users**                    | Realtime publish fails silently; organizers miss live updates (attendance still recorded) |
| 2     | Sentry — 100 replays/mo        | <100 users                        | Replays dropped after 100th (config fix: lower sample to 0.01)                            |
| 3     | Ably — 3M msgs/mo              | ~600 users (peak) / ~2,000 (mean) | Ably 429s; same silent failure                                                            |
| 4     | Vercel — 100 GB bandwidth      | ~1,300 MAU                        | 502/503 over quota                                                                        |
| 5     | Vercel — 10s function cap      | ~1,500 users                      | Scan POST truncated → 504 (idempotency prevents double-count)                             |
| 6     | Sentry — 5,000 errors/mo       | ~1,500 users                      | Errors dropped (config fix: lower sampleRate to 0.3)                                      |
| 7     | Supabase — 200 pooler conns    | ~3,000 users                      | New Vercel instances fail to acquire DB connection → 500s                                 |
| 8     | Sentry — 50k perf transactions | ~2,200 users                      | Transactions dropped                                                                      |

**Bottleneck platform: Ably** — breaks between 500 and 2,000 concurrent users depending
on organizer fanout. Graceful degradation (fire-and-forget), so attendance recording
continues; only the live dashboard updates degrade.

---

## 4. Database Layer Assessment

### Table growth at scenario scale (2,000 users / 200 events / 50% attendance)

| Table                          | Rows/month | Size (rows + indexes) |
| ------------------------------ | ---------- | --------------------- |
| **event_attendance**           | 200,000    | ~200 MB               |
| **notifications** (worst case) | 400,000    | ~120 MB               |
| audit_logs                     | 3,000      | ~2 MB                 |
| accounts + events + tokens     | small      | ~10 MB                |
| **TOTAL monthly growth**       |            | **~330 MB**           |

**Supabase Free (500 MB) → exhausted in ~6 weeks.** Even with the 30-day
read-notification cleanup cron, `event_attendance` grows unbounded (no purge policy).

### Index coverage

**Well-covered** (verified against API routes):

- `(eventId, accountId)` UNIQUE → atomic one-attempt check
- `(accountId, scannedAt)`, `(eventId, scannedAt)` → attendance history + roster
- `(status, scheduledAt)` → event listing
- UNIQUE `tokenHash`, `fingerprint`, `idempotencyKey`, `certificateNonce` → O(1) lookups
- Partial UNIQUE `(supabase_auth_uid) WHERE NOT NULL` → session lookup

**Index gaps**:

- `accounts.createdAt` — admin roster sorts by this, no index
- `(ownerId, status, scheduledAt)` on events — only `(ownerId, status)` exists
- **No `pg_trgm`/GIN indexes** — 7 routes use `LIKE '%q%'` (sequential scans):
  `/api/accounts`, `/api/events`, `/api/whitelist`, `/api/audit-logs`,
  `/api/attendance/overrides`, `/api/cron/event-reminders` (dedup check)

### Connection pooling

- `?pgbouncer=true&connection_limit=1&pool_timeout=20` (Supavisor, transaction mode)
- Each Vercel instance = max 1 pooled connection
- Max 200 pooler connections (Free) → max ~200 concurrent Vercel instances
- **Worst case**: class-start flash crowd (2000 students open app simultaneously)
  → Vercel spawns 100+ instances → each grabs 1 connection → pool exhaustion risk
- **RLS adds zero production overhead** (Prisma uses service_role which bypasses RLS)

### Top DB risks (ranked)

1. **CRITICAL — `cron/event-reminders` N×M loop**: 5 events × 500 students = 2,500
   sequential DB calls per cron tick. No `maxDuration` — will exceed Vercel's 10s
   Hobby cap and hold PgBouncer connections hostage.
2. **`LIKE '%q%'` on growing tables** — 7 routes force sequential scans.
3. **`event_attendance` unbounded growth** — no purge policy.
4. **`audit_logs` indefinite append** — no purge policy (~22 MB/year, slow but unbounded).

---

## 5. API Route Bottlenecks (top 3 + honorable mentions)

### TOP-1: `POST /api/auth/passkey/login-verify` — CRITICAL

- **Issue**: `findMany({ where: { passkeyCredential: { not: null } } })` loads EVERY
  passkey-registered account, then a for-loop runs `verifyAuthenticationResponse`
  (Ed25519 crypto) per account until one matches.
- **Impact**: At 100+ passkey holders, a single login request executes N crypto
  operations. No `maxDuration` → Vercel Hobby 10s ceiling hit under any concurrency.
- **Fix**: Add indexed `passkeyCredentialId` column; look up via
  `findUnique({ where: { passkeyCredentialId } })` instead of N-row scan.

### TOP-2: `GET /api/whitelist` — HIGH

- **Issue**: Both `account.findMany` and `authorizedStudent.findMany` have NO
  `take`/`skip` — entire result sets loaded into memory, merged, JS-sorted, sliced.
- **Impact**: 5,000 students = ~10,000 rows fetched + JS sort per cache miss.
- **Fix**: Push pagination into SQL (raw UNION with LIMIT/OFFSET, or two-query slice).

### TOP-3: `GET /api/events/[id]/attendance` — HIGH

- **Issue**: `findMany({ where: { eventId } })` with NO `take`/`skip` — returns ALL
  attendance rows. `private, no-cache` → every request hits origin.
- **Impact**: 1,000-attendee event = ~150KB JSON per response, every request. Polled
  by the Overrides page.
- **Fix**: Add `?page=&pageSize=` (default 100, max 200); relax Cache-Control to
  `private, s-maxage=10, stale-while-revalidate=30`.

### Honorable mentions

- **`/api/cron/event-reminders`** — N+1 sequential queries per student per event.
  Fix: bulk-fetch existing reminders + `createMany`.
- **`/api/auth/check`, `/api/auth/register`, `/api/accounts/create`** — all call
  `admin.auth.admin.listUsers()` (fetches 1,000 users) to check ONE email for orphan
  reconciliation. Fix: use scoped `getUserByEmail` or query `auth.users` directly.
- **`/api/dashboard`** (admin path) — 2 sequential `groupBy` after `Promise.all`.
  Fix: include both in the existing `Promise.all`.
- **`/api/attendance/override`** — redundant `findUnique({ where: { studentId } })`
  called twice. Fix: reuse the first lookup.
- **`maxDuration` coverage** — only 3 of ~30 routes set it. All Supabase-admin-call
  routes (`login`, `register`, `forgot-password`, `accounts/create`) risk the 10s
  Hobby cap under contention.

---

## 6. Rate Limiting, Caching & Realtime Assessment

### Rate-limit presets

| Preset                | Max/window | Keyed on                             | Assessment                                                                                                                |
| --------------------- | ---------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `login`               | 5/min      | per-IP + **per-email** + per-account | ✅ Per-email is the real backstop for NAT'd campus WiFi. Per-IP remains tight on shared IP (known trade-off, documented). |
| `register`            | 5/min      | per-IP                               | ⚠️ Same shared-IP problem for onboarding. Acceptable for trickle onboarding; bulk onboarding should be staggered.         |
| `otp`                 | 5/min      | per-IP                               | ✅ OK — OTP requests are naturally rare.                                                                                  |
| `check`               | 15/min     | per-IP                               | ⚠️ Marginal at 2000 users on shared IP.                                                                                   |
| `scan`                | 60/min     | per-IP (fallback only)               | ✅ Authed scans use `scanAccount` (per-account).                                                                          |
| `scanAccount`         | 30/min     | per-account                          | ✅ Each student scans once per event.                                                                                     |
| `apiAccount`          | 100/min    | per-account                          | ✅ Auto-applied via `requireAuth`.                                                                                        |
| `passkeyRegister`     | 10/min     | per-account                          | ✅ New — prevents credential-table pollution.                                                                             |
| `adminMutation`       | 20/min     | per-account                          | ✅ New — closes admin-driven DoS on account create/delete.                                                                |
| `whitelistImport`     | 3/min      | per-account                          | ✅ New — closes 500k row-updates/min DoS vector.                                                                          |
| `whitelistImportFile` | 5/min      | per-account                          | ✅ New — closes CPU-exhaustion via heavy file parsing.                                                                    |

### In-memory vs Upstash

- In-memory fallback (`Map`) is **per-Vercel-instance** — each instance has its own
  buckets. 10 instances = 10× the effective brute-force budget. **Now LRU-capped at
  10,000 keys** to prevent memory exhaustion under IP rotation.
- **Fail-open on Upstash errors** for general presets (avoids locking all users on
  serverless). **Sensitive presets fail closed** (login, register, otp, passkeyVerify,
  passkeyRegister, passkeyAccount, loginAccount, adminMutation, whitelistImport,
  whitelistImportFile) — an attacker cannot DDoS Upstash to bypass brute-force
  protection.
- **Caddy tier (5/60/100 r/m per-IP)** is the real backstop when Caddy is in the path.
  On pure Vercel without Caddy, none of those backstops exist.

### Account cache (30s TTL)

- Saves ~6,000 DB queries/min at 2000 users × 5 API calls/min (60% reduction).
- **Multi-instance caveat**: with N Vercel instances, cache effectiveness drops ~1/N
  under uniform load balancing.
- `supabase.auth.getUser()` (network round-trip to Supabase Auth) is NOT cached —
  only the Prisma query is. Could be eliminated by local JWT validation.

### Ably realtime capacity

- **Free tier**: 3M msgs/mo, 200 concurrent connections, 1,000 msg/s peak.
- **2,000 students scanning in 15 min**: 2,000 messages/event × 10 organizers = 20,000
  fanout messages/event. At 30 events/month = 600,000 messages → <2% of free tier. ✅
- **Peak rate**: 2,000 scans / 15 min = ~133 scans/min × 10 subscribers = 1,333 msg/s
  → **exceeds 1,000 msg/s peak** ❌
- **Concurrent connections**: organizers only (~10-50) → ~10% of free tier. ✅
- **When it breaks**: 200+ organizers concurrently watching (large university) OR
  students wired to realtime (current design correctly keeps students off Ably).

### Caddy rate limits (per-IP, behind school NAT)

- **Scan tier (60 r/m)**: fine for ≤200 students / 5-min window; fails for ≥500
  students / 5-min from one school IP (100/min → 40% blocked).
- **General API (100 r/m)**: 2,000 students × 1-5 req/min from one IP = 2,000-10,000
  req/min → **exceeds ceiling 20-100×**. This is the single hardest ceiling for
  school deployments.

### CSRF middleware overhead

- ~5-10 string comparisons + 1-2 `URL` parses per mutation request.
- **<0.5ms CPU per request**. At 1,000 req/s = <5% of one core. **Negligible.**

---

## 7. Capacity Estimates by User Tier

| Concurrent users | Free tier status                                | First wall                                   | Action needed                                                     |
| ---------------- | ----------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| **100**          | ✅ All green                                    | None                                         | None — app handles this comfortably                               |
| **500**          | ⚠️ Ably peak msg/s borderline                   | Ably 1,000 msg/s (50 organizers × 30s burst) | Upgrade Ably OR reduce fanout                                     |
| **1,000**        | ❌ Ably msg/s exceeded; Sentry replays exceeded | Ably + Sentry config                         | Upgrade Ably; lower Sentry replay sample to 0.01                  |
| **1,300**        | ❌ Vercel bandwidth exceeded                    | Vercel 100GB/mo                              | Upgrade to Vercel Pro ($20/mo)                                    |
| **2,000**        | ❌ Multiple limits exceeded                     | Ably + Vercel + Supabase storage (~6 weeks)  | Upgrade all platforms; fix passkey + whitelist + cron bottlenecks |
| **3,000+**       | ❌ Supabase pooler exhausted                    | 200 pooler connections                       | Supabase Pro; `connection_limit=2-3`                              |

---

## 8. Recommendations (priority order)

### Immediate (config-only, no code changes)

1. **Lower Sentry `replaysOnErrorSampleRate`** from `1.0` → `0.01` in
   `sentry.client.config.ts`. Instant fix for the 100-replay/mo cap.
2. **Lower Sentry `sampleRate`** to `0.3` (client) and `0.5` (server) if MAU
   approaches 1,500.
3. **Set `maxDuration = 10`** on `/api/attendance/route.ts` when on Vercel Hobby
   (fail fast instead of silent truncation).

### Code fixes (high impact, low effort)

4. **Fix passkey login-verify** (TOP-1): schema migration to add indexed
   `passkeyCredentialId` column; change login-verify to single-row lookup. Eliminates
   N-row scan + N crypto ops.
5. **Fix `/api/events/[id]/attendance` pagination** (TOP-3): add `page`/`pageSize`
   params + `Promise.all` count + relaxed Cache-Control.
6. **Fix `/api/whitelist` GET pagination** (TOP-2): push pagination into SQL (raw
   UNION or two-query slice).
7. **Fix `/api/cron/event-reminders` N+1**: bulk-fetch existing reminders via
   `findMany` + `createMany` the missing. Prevents cron DoS.
8. **Replace `admin.listUsers()` calls** in `/api/auth/check`, `/api/auth/register`,
   `/api/accounts/create` with scoped `getUserByEmail` or direct `auth.users` query.

### Infrastructure upgrades (before ~1,300 MAU)

9. **Upgrade Vercel to Pro** ($20/mo): 1 TB bandwidth, 60s function duration.
10. **Upgrade Ably** to Pro ($29/mo: 6M msgs/mo, 1,000 peak msg/s) OR replace with
    self-hosted SSE broadcaster via Caddy (eliminates per-message billing).
11. **Re-add a CDN/edge cache**: Cloudflare free proxy in front of Vercel, OR restore
    a minimal worker for `s-maxage` GET routes. Extends bandwidth ceiling 3-5×.
12. **Configure Upstash Redis** for distributed rate limiting (eliminates per-instance
    leak on Vercel serverless).

### Database optimizations (before ~2,000 MAU)

13. **Add `pg_trgm` GIN indexes** on `accounts.fullName`, `accounts.email`,
    `events.title`, `audit_logs.action`, `authorized_students.fullName`,
    `authorized_students.email`, `notifications.body` — turns `LIKE '%q%'` from seq
    scan to ~O(log N).
14. **Add purge policy** for `event_attendance` older than 180 days (archive to cold
    storage).
15. **Add purge policy** for `audit_logs` (keep 90 days, archive rest).
16. **Add composite `(ownerId, status, scheduledAt)` index** on events.
17. **Cache JWT validation locally** instead of calling `supabase.auth.getUser()`
    per request — eliminates one network round-trip per cold-start request.
18. **Migrate to Supabase Pro** ($25/mo) for 8 GB storage + higher pooler ceiling
    before crossing 400 MB or 150 concurrent users.

### Architectural (before multi-school rollout, 5,000+ MAU)

19. **Consider `connection_limit=2-3`** for higher Prisma concurrency.
20. **Move account cache to Redis** (Upstash) so all Vercel instances share one cache.
21. **Defer audit writes** via `waitUntil` (Vercel) or a queue on hot paths
    (`/api/attendance`, `/api/attendance/override`, `/api/auth/login`).
22. **Consider partitioning** `event_attendance` by month for very large deployments.

---

## 9. Scalability Strengths (what's already done well)

- **30s account cache** in `supabase-session.ts` — saves ~60% of DB queries at 2000 users.
- **10s maintenance cache** in `api.ts` — saves a `Setting.findUnique` per authed request.
- **`scanAccount` rate limit is per-account, not per-IP** — critical for school WiFi
  where 200+ students share one public IP.
- **`apiAccount` auto-applied via `requireAuth`** — every authed route inherits a
  100/min ceiling without per-route boilerplate.
- **Idempotency + UNIQUE(eventId, accountId)** — scan race conditions handled via
  P2002 catch; prevents double-counting.
- **Tiered Caddy rate limits** — auth 5r/m, scan 60r/m, general 100r/m.
- **Service worker** — stale-while-revalidate on app shell reduces Vercel bandwidth
  ~80% for repeat-visit navigations.
- **Explicit Cache-Control on all GET routes** — per-user routes use `private, no-cache`
  (correct); public routes use `public, s-maxage` (edge-cacheable).
- **Ably kept organizers-only** — students don't connect, keeping the app well under
  the 200-connection free-tier limit even at 200 concurrent users.
- **bcrypt cost 12 + Ed25519 device-bound certificates** — security isn't compromised
  for scaling; the anti-cheating stack is cryptographically sound.
- **Promise.all discipline** — most routes parallelize independent queries.
- **`select` discipline** — most routes fetch only needed columns (exceptions noted).

---

## 10. Conclusion

Nexus Gate is **production-ready for a single school (up to ~500 concurrent users on
free tiers)**. The architecture is sound: defense-in-depth security, proper RBAC,
realtime scoped to organizers, idempotent scan flow, and explicit cache directives.

The **first hard wall is Ably's 1,000 msg/s peak** (~500 users in a burst scenario),
which degrades gracefully (attendance still records; only live dashboard updates fail).
The **first storage wall is Supabase's 500 MB** (~6 weeks at 2000 users, driven by
`event_attendance` growth). The **first bandwidth wall is Vercel's 100 GB/mo**
(~1,300 MAU).

The **~~4 code-level bottlenecks~~** (passkey login N-scan, whitelist unbounded load,
event-attendance unbounded load, cron N+1) ~~are all fixable with moderate effort~~
have been **fixed** (see below). The passkey login-verify fix was the single
highest-impact change — it was both a scalability bug and a potential DoS vector
(one request triggered N crypto operations).

With the recommended fixes + Vercel Pro + Ably Pro + Supabase Pro (~$75/mo total),
the app can comfortably handle **2,000–3,000 concurrent users** — the documented
scalability target. Beyond that, horizontal scaling (multiple Next.js instances,
Redis-backed cache, DB read replicas) would be needed.

---

## 11. Resolved Bottlenecks (2026-07-15)

All 4 code-level bottlenecks identified in §5 and §8 have been resolved:

| #     | Bottleneck                                       | Resolution                                                                                                       | File                                             |
| ----- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| TOP-1 | Passkey `login-verify` N-row scan + N crypto ops | O(log N) lookup via indexed `passkey_credential_id` column + raw SQL `WHERE passkey_credential_id = ... LIMIT 1` | `src/app/api/auth/passkey/login-verify/route.ts` |
| TOP-2 | Whitelist GET unbounded load + JS sort           | SQL pagination (`skip`/`take: pageSize`) on both tables + `Promise.all` count                                    | `src/app/api/whitelist/route.ts`                 |
| TOP-3 | Events `[id]/attendance` unbounded load          | `paginationSchema` + `skip`/`take` + `Promise.all` (attendances, count, eligibleCount)                           | `src/app/api/events/[id]/attendance/route.ts`    |
| TOP-4 | Cron `event-reminders` N×M sequential loop       | Bulk-fetch all eligible students once + dedup `Set` + `createMany`                                               | `src/app/api/cron/event-reminders/route.ts`      |

**Additional optimizations done since this report:**

- pg_trgm GIN indexes on 7 columns (migration `0011`) — `LIKE '%q%'` is now ~O(log N)
- Composite index `(ownerId, status, scheduledAt)` on events (migration `0011`)
- `accounts.createdAt` index (migration `0011`)
- Purge cron for `event_attendance` (>365d) + `audit_logs` (>365d) in `/api/cron/cleanup`
- `admin.listUsers()` replaced with direct SQL `SELECT id FROM auth.users WHERE email = ...` in 3 routes
- Sentry `replaysOnErrorSampleRate` lowered to `0.01` (was `1.0`)
- Ably token route uses SDK `createTokenRequest` (eliminates hand-rolled HMAC bugs)
- Ably publish retry (1 retry after 2s for transient failures)
- Caddy scan rate limit raised 60r/m → 200r/m (per-account limit is the real backstop)

---

## 12. Second-Round Hardening (2026-07-20)

A second pass focused on security + concurrency + performance hardening
within the same free-tier constraints. These fixes do not raise the hard
infra ceilings (Ably msg/s, Vercel bandwidth, Supabase storage) but they
close code-level ceilings that would have hit _before_ the infra ceilings,
raising the _effective_ capacity and closing OWASP 2025 findings.

| #   | Fix                                    | Category                  | File(s)                                                        | Capacity / security impact                                                                                                                                                                                        |
| --- | -------------------------------------- | ------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **Enumeration-safe login**             | OWASP A07                 | `auth/login/route.ts`                                          | Single generic 401 for wrong-password / non-existent / unconfirmed / deactivated + dummy bcrypt timing equalization. Closes user-enumeration oracle.                                                              |
| S2  | **Ably token event-visibility check**  | OWASP A01 / API#1 (BOLA)  | `ably/token/route.ts`                                          | Students can no longer subscribe to another section's realtime channel. Closes PII harvest vector.                                                                                                                |
| S3  | **accounts/create error leak fix**     | OWASP A10                 | `accounts/create/route.ts`                                     | Raw Supabase error replaced with generic message + server-side log. Closes email-enumeration oracle.                                                                                                              |
| S4  | **Login lockout TOCTOU**               | Concurrency               | `auth/login/route.ts`                                          | Lock-set is now a compare-and-set `updateMany({ where: { lockedUntil: null } })`. Two concurrent failures cannot both skip the lock.                                                                              |
| S5  | **Profile + password cooldown TOCTOU** | Concurrency               | `profile/route.ts`, `profile/password/route.ts`, `cooldown.ts` | Conditional `updateMany` (where `lastChangedAt` null OR lt cutoff). Concurrent requests cannot halve the 30-day cooldown.                                                                                         |
| S6  | **Stable P2002 detection**             | Concurrency / correctness | `prisma-errors.ts` (new) + 3 routes                            | Replaces fragile `msg.includes("Unique constraint")` with `e.code === "P2002"`. Locale- and version-stable.                                                                                                       |
| S7  | **Rate-limiter LRU cap**               | DoS / memory              | `rate-limit.ts`                                                | In-memory `memoryBuckets` Map capped at 10,000 keys. Closes memory-exhaustion DoS under IP rotation.                                                                                                              |
| S8  | **Admin/import rate limits**           | OWASP A07 / API#4         | `rate-limit.ts`, `api.ts`, 6 routes                            | New presets: `adminMutation` 20/min, `whitelistImport` 3/min, `whitelistImportFile` 5/min, `passkeyRegister` 10/min. All fail closed. Closes admin-driven DoS.                                                    |
| S9  | **Profile stats 3→1 query collapse**   | Performance               | `profile/stats/route.ts`                                       | My-Attendance chart, scope breakdown, and streak derived from 1 `findMany` with JS bucketing. Saves 2 DB round-trips per page load → pushes the Supabase-200-connection ceiling from ~2,000 to ~2,500 concurrent. |
| S10 | **Override duplicate query removal**   | Performance               | `attendance/override/route.ts`                                 | Removed redundant second `findUnique` on the same `studentId`.                                                                                                                                                    |

**Verification**: `bunx tsc --noEmit` 0 errors; `bun run lint` 5 pre-existing
errors (zero new); `bun run test` 368 tests / 360 pass / 8 pre-existing fail
(in `validation.test.ts`, untouched). 25 new unit tests added (prisma-errors

- cooldownCutoff), all passing.

**Remaining recommendations (not yet done — defer until scale demands):**

- Local JWT validation (skip `supabase.auth.getUser()` network call)
- Move account cache to Redis (needs Upstash configured)
- Defer audit writes via `waitUntil` (Vercel-specific)
- Ably presence + delta compression (premature under 50 organizers/event)
- `event_attendance` purge policy decision (product owner) — 500 MB Supabase Free exhausted in ~6 weeks at 2,000 users
