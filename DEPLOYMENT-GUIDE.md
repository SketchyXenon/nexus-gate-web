# Nexus Gate — Deployment Guide

## Prerequisites

- **Node.js** 18+ (or Bun 1.0+)
- **Supabase** account (free tier — PostgreSQL + Auth)
- **Ably** account (free tier — realtime)
- **Vercel** account (free tier — hosting)

## Quick Start (Local Development)

```bash
# 1. Install dependencies
bun install

# 2. Set up environment variables
cp example.env .env
# Edit .env with your Supabase + Ably keys

# 3. Create the first admin account
bun run bootstrap:admin

# 4. Push the database schema (SQLite for local dev)
bun run db:push:sqlite

# 5. Start the dev server
bun run dev
```

The app will be available at `http://localhost:3000`.

## Production Deployment (Vercel + Supabase + Ably)

### Step 1: Set Up Supabase (Free)

1. Go to [supabase.com](https://supabase.com) → New Project
2. Name it `nexus-gate`, choose a region close to your users
3. Wait for provisioning (~2 min)
4. Go to **Settings → API**:
   - Copy `Project URL` → this is your `NEXT_PUBLIC_SUPABASE_URL`
   - Copy `anon public` key → this is your `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - Copy `service_role` key → this is your `SUPABASE_SERVICE_ROLE_KEY`
5. Go to **Settings → Database → Connection string**:
   - Copy the **Transaction** URL (port 6543) → this is your `DATABASE_URL`
   - Copy the **Session** URL (port 5432) → this is your `DIRECT_URL`
6. Go to **SQL Editor** → run the migration files from `supabase/migrations/` in order (0001 through 0016)
7. Go to **Authentication → URL Configuration**:
   - Set **Site URL** to your Vercel URL (e.g., `https://nexus-gate-web.vercel.app`)
   - Add your Vercel URL to **Redirect URLs**

### Step 2: Set Up Ably (Free)

1. Go to [ably.com](https://ably.com) → Sign up (free)
2. Create a new app → name it `nexus-gate`
3. Go to **Settings → API Keys**
4. Copy the **root API key** (format: `keyName:keySecret`, e.g. `KyAKwA.hI9kKQ:xxxx`)
5. Set this as `ABLY_SERVER_KEY` on Vercel. This is the ONLY Ably env var needed —
   the browser uses token authentication via `/api/ably/token` (signed by the
   server key). Do NOT set `NEXT_PUBLIC_ABLY_KEY` — it is unused and will
   cause confusion.

### Step 3: Deploy to Vercel (Free)

1. Go to [vercel.com](https://vercel.com) → New Project
2. Import your GitHub repo (`nexus-gate-web`)
3. Vercel auto-detects Next.js — no build config needed
4. Set **Environment Variables**:

```
DATABASE_URL=postgresql://postgres.[REF]:[PASS]@aws-0-[REGION].pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&pool_timeout=20
NEXT_PUBLIC_SUPABASE_URL=https://[REF].supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=[your-anon-key]
SUPABASE_SERVICE_ROLE_KEY=[your-service-role-key]
NEXT_PUBLIC_APP_URL=https://nexus-gate-web.vercel.app
ABLY_SERVER_KEY=[your-ably-keyName:keySecret]
AUTH_SECRET=[generate-with: openssl rand -base64 32]
REFRESH_SECRET=[generate-with: openssl rand -base64 32]
CRON_SECRET=[generate-with: openssl rand -base64 32]
```

5. Click **Deploy**
6. Wait for the build to complete (~2 min)

### Step 4: Create Admin Account

After the first deploy, create the admin account:

```bash
# Set DATABASE_URL to your Supabase connection string
DATABASE_URL="postgresql://..." bun run bootstrap:admin
```

Or use the Vercel CLI:
```bash
vercel env pull .env
bun run bootstrap:admin
```

### Step 5: Set Up Cron Jobs

Go to your cron service (cron-job.org, Vercel Cron, etc.) and set up:

**Event Reminders** (daily at 8 AM):
```
URL: https://nexus-gate-web.vercel.app/api/cron/event-reminders?secret=YOUR_CRON_SECRET
Method: GET
Schedule: 0 8 * * *
```

**Cleanup** (daily at 3 AM):
```
URL: https://nexus-gate-web.vercel.app/api/cron/cleanup?secret=YOUR_CRON_SECRET
Method: GET
Schedule: 0 3 * * *
```

### Step 6: Self-Hosting with Caddy (Optional)

If you're self-hosting instead of deploying to Vercel, use the included
`Caddyfile` as a reverse proxy in front of the Next.js app (port 3000).

The Caddyfile includes a production block (port 80) and a dev block (port 81).
Edit the production block to add your domain for automatic TLS via Let's
Encrypt. Without a custom domain, Caddy serves HTTP only — use a TLS
terminator or deploy on Vercel for HTTPS.

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Supabase PostgreSQL connection (pooler, port 6543) |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (server-only) |
| `NEXT_PUBLIC_APP_URL` | Yes | Your production URL |
| `ABLY_SERVER_KEY` | Yes | Ably server key (`keyName:keySecret`). Signs token requests server-side. |
| `AUTH_SECRET` | Yes | HMAC signing secret (generate with `openssl rand -base64 32`) |
| `REFRESH_SECRET` | Yes | Refresh token signing secret (separate from AUTH_SECRET) |
| `CRON_SECRET` | Yes | Secret for cron endpoint authentication |
| `SENTRY_DSN` | No | Error monitoring (Sentry) |
| `SMTP_HOST` | No | Email server (for password reset) |
| `SMTP_PORT` | No | Email server port |
| `SMTP_USER` | No | Email server username |
| `SMTP_PASS` | No | Email server password |
| `SMTP_FROM` | No | Sender email address |
| `UPSTASH_REDIS_REST_URL` | No | Distributed rate limiting (Redis) |
| `UPSTASH_REDIS_REST_TOKEN` | No | Distributed rate limiting (Redis) |

## Cost Summary

| Service | Plan | Cost |
|---------|------|------|
| Vercel | Hobby | $0/mo |
| Supabase | Free | $0/mo |
| Ably | Free | $0/mo |
| Cloudflare | Free | $0/mo |
| **Total** | | **$0/mo** |

## Troubleshooting

### Ably returns 40400 "No application found"
`ABLY_SERVER_KEY` is malformed. The key must be `keyName:keySecret` (colon-separated), where keyName is `appId.keyId` (dot-separated). Copy the FULL key from the Ably dashboard — do not split it manually.

### Ably returns 40101 "Request mac does not match"
The token route now uses the Ably SDK's `createTokenRequest` for signing. If you see this error, ensure you redeployed after the latest code changes — old deployments used hand-rolled HMAC that produced the mac in hex instead of base64.

### Magic link redirects to localhost:3000
Set `NEXT_PUBLIC_APP_URL` on Vercel to your production URL. The register route uses this for the `emailRedirectTo` parameter.

### CSP blocks Ably WebSocket
The CSP allows `*.ably.io` and `*.ably.net`. If Ably uses a different domain, add it to `connect-src` in `src/proxy.ts`.

### Cron returns 401
Set `CRON_SECRET` on Vercel. Pass it via `?secret=YOUR_SECRET` in the cron URL, or via `Authorization: Bearer YOUR_SECRET` header.

### Scanner shows "key is not extractable"
Clear your browser data for the site. The old non-extractable keypair is regenerated on next visit.
