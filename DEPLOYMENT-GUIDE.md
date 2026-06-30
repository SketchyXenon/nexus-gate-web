# Nexus Gate — Deployment Guide

## Prerequisites

- **Node.js** 18+ (or Bun 1.0+)
- **PostgreSQL** 15+ (Supabase recommended)
- **Caddy** 2.7+ (gateway/reverse proxy)

## Quick Start (Local Development)

```bash
# 1. Install dependencies
bun install

# 2. Set up environment variables
cp .env.example .env
# Edit .env with your values

# 3. Create the first admin account
bun run bootstrap:admin

# 4. Push the database schema
bun run db:push

# 5. Start the dev server
bun run dev
```

The app will be available at `http://localhost:3000`.

## Production Deployment (Supabase + Vercel)

### Step 1: Set Up Supabase

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and run the migrations in order:
   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_settings_and_views.sql`
   - `supabase/migrations/0003_strict_rls_indexes_v7.sql`
   - `supabase/migrations/0004_device_keys_certificates_v8.sql`
   - `supabase/migrations/0005_security_hardening_scalability_v8.sql`
3. Note your connection strings:
   - **Pooler URL** (port 6543): `postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&pool_timeout=20`
   - **Direct URL** (port 5432): `postgresql://postgres.[ref]:[password]@aws-0-[region].supabase.com:5432/postgres`

### Step 2: Set Up Vercel

1. Push your code to GitHub/GitLab
2. Go to [vercel.com](https://vercel.com) and import the repository
3. Set the following environment variables in Vercel:

   | Variable | Required | Description |
   |----------|----------|-------------|
   | `DATABASE_URL` | ✅ | Supabase pooler connection string (port 6543) |
   | `DIRECT_URL` | ✅ | Supabase direct connection string (port 5432) |
   | `AUTH_SECRET` | ✅ | Random 32+ byte secret for JWT signing |
   | `REFRESH_SECRET` | ✅ | Different random 32+ byte secret for refresh token hashing |
   | `NEXTAUTH_SECRET` | ✅ | Different random 32+ byte secret for NextAuth |
   | `NEXTAUTH_URL` | ✅ | Your production URL (e.g. `https://nexusgate.example.com`) |
   | `NEXT_PUBLIC_APP_URL` | ✅ | Same as NEXTAUTH_URL |
   | `CRON_SECRET` | ✅ | Random secret for cron endpoint protection |
   | `SMTP_HOST` | ⚠️ | Gmail SMTP host (`smtp.gmail.com`) |
   | `SMTP_PORT` | ⚠️ | Gmail SMTP port (`587`) |
   | `SMTP_USER` | ⚠️ | Gmail account email |
   | `SMTP_PASS` | ⚠️ | Gmail app password (NOT your regular password) |
   | `SMTP_FROM` | ⚠️ | From email address |
   | `SMTP_FROM_NAME` | ⚠️ | From display name (default: `Nexus Gate`) |
   | `UPSTASH_REDIS_REST_URL` | ⚠️ | Upstash Redis URL for distributed rate limiting |
   | `UPSTASH_REDIS_REST_TOKEN` | ⚠️ | Upstash Redis token |
   | `GOOGLE_CLIENT_ID` | ⚠️ | Google OAuth client ID (optional) |
   | `GOOGLE_CLIENT_SECRET` | ⚠️ | Google OAuth client secret (optional) |
   | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | ⚠️ | Cloudflare Turnstile site key (optional) |
   | `TURNSTILE_SECRET_KEY` | ⚠️ | Cloudflare Turnstile secret key (optional) |
   | `SENTRY_DSN` | ⚠️ | Sentry DSN for error monitoring (optional) |
   | `NEXT_PUBLIC_SENTRY_DSN` | ⚠️ | Public Sentry DSN (optional) |

   **Generate secrets with:** `openssl rand -base64 32`

4. Deploy. Vercel will automatically build and deploy.

### Step 3: Set Up Caddy (Gateway)

If using Caddy as a reverse proxy/gateway:

1. Install Caddy on your server
2. Copy the `Caddyfile` to `/etc/caddy/Caddyfile`
3. Replace the `:81` listener with your domain
4. Uncomment TLS directives (`tls internal` for dev, `tls your@email.com` for prod)
5. Restart Caddy: `systemctl restart caddy`

### Step 4: Create the First Admin

After deployment, create the first admin account:

```bash
# If running locally with access to the DB:
BOOTSTRAP_ADMIN_EMAIL="admin@yourschool.edu" \
BOOTSTRAP_ADMIN_PASSWORD="StrongPassword123!" \
BOOTSTRAP_ADMIN_NAME="System Administrator" \
bun run bootstrap:admin

# Or run the SQL directly in Supabase SQL Editor:
-- See scripts/bootstrap-admin.ts for the logic
```

### Step 5: Set Up Cron Jobs (Vercel)

The `vercel.json` file defines two cron jobs:
- `/api/cron/event-reminders` — sends event reminder notifications (runs every 5 minutes)
- `/api/cron/cleanup` — cleans up expired tokens (runs daily at midnight)

Vercel automatically sends the `CRON_SECRET` as a Bearer token. No additional setup needed.

### Step 6: Set Up the Realtime Mini-Service (Optional)

For real-time attendance updates (WebSocket):

1. Deploy `mini-services/realtime/` to Render, Railway, or Fly.io
2. Set `REALTIME_URL` in your main app to the deployed service URL
3. Set `NEXT_PUBLIC_REALTIME_URL` for the client-side WebSocket connection

If not deployed, the app falls back to polling every 4 seconds.

## Post-Deployment Checklist

- [ ] All 5 Supabase migrations applied successfully
- [ ] First admin account created and can log in
- [ ] `AUTH_SECRET`, `REFRESH_SECRET`, `NEXTAUTH_SECRET` are all different random strings
- [ ] `CRON_SECRET` is set and cron jobs are running
- [ ] HTTPS is enforced (Caddy TLS or Vercel automatic HTTPS)
- [ ] Rate limiting is working (test with rapid login attempts)
- [ ] RLS is enabled on all tables (verify in Supabase dashboard)
- [ ] The `is_admin()` function has `REVOKE ALL FROM PUBLIC` applied
- [ ] Email notifications work (test forgot-password flow)
- [ ] File upload works (test whitelist import with .xlsx, .pdf, .docx)
- [ ] QR code scanning works (test with a real device)
- [ ] Offline scan queue works (test by disabling WiFi mid-scan)

## Scaling Considerations

### Database
- **Connection pooling**: Use Supabase's PgBouncer pooler (port 6543) for the app. Use the direct connection (port 5432) only for migrations.
- **Indexes**: All composite indexes are defined in `prisma/schema.prisma` and mirrored in the Supabase migrations. No additional index tuning needed for <100k students.
- **Partitioning**: For >100k attendance records, consider partitioning `event_attendance` by month. This requires raw SQL (Prisma doesn't natively support partitioning).

### Rate Limiting
- **In-memory** (default): Works for single-instance deployments. State is lost on restart.
- **Upstash Redis** (recommended for production): Distributed rate limiting across multiple instances. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

### Realtime
- The mini-service (`mini-services/realtime/`) handles WebSocket connections for live attendance updates.
- If not deployed, the app falls back to polling every 4 seconds.
- For high-traffic events (>500 concurrent viewers), deploy the realtime service on a dedicated instance.

## Backup

### Database Backup
- Supabase: Automatic daily backups on Pro plan and above.
- Self-hosted: Use `pg_dump` nightly.

### Code Backup
- Git repository (GitHub/GitLab).

## Monitoring

- **Sentry**: Set `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` for error monitoring.
- **Supabase Dashboard**: Monitor query performance and connection pool usage.
- **Vercel Dashboard**: Monitor function execution time and deployment status.

## Troubleshooting

### "Invalid `db.setting.findMany()` invocation" error
- Ensure `DATABASE_URL` starts with `file:` for SQLite (dev) or `postgresql://` for PostgreSQL (prod).
- Run `bun run db:push` to sync the schema.

### Rate limit not working
- If using Upstash, verify `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set.
- The app falls back to in-memory rate limiting if Upstash is not configured.

### CORS errors
- The app uses relative API paths (`/api/...`). No CORS configuration needed.
- If the realtime mini-service has CORS issues, set `ALLOWED_ORIGINS` in the mini-service environment.

### QR code not scanning
- Ensure the projector's device clock is synced (NTP).
- The QR refreshes every 500ms — the scanner must capture 3+ consecutive frames.
- Check that `eventSecret` is not exposed to students (it should only be in ORGANIZER/ADMIN API responses).
