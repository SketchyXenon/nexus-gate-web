export function getAppUrl(): string {
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.RENDER_EXTERNAL_URL?.trim() ||
    process.env.VERCEL_URL?.trim();

  if (appUrl) {
    if (appUrl.startsWith("http://") || appUrl.startsWith("https://")) {
      return appUrl;
    }
    return `https://${appUrl}`;
  }

  return "";
}

// Safe base URL for Supabase email-redirect targets (confirm/magic/reset).
// SECURITY: never fall back to req.nextUrl.origin — that is attacker-controllable
// via the Host/X-Forwarded-Host header on a direct (non-browser) POST, which would
// let an attacker inject their own domain into the confirmation/reset email link.
// In dev (no env) origin is localhost and safe; in production we return "" so
// Supabase falls back to its dashboard-configured Site URL (also safe) rather
// than an attacker-supplied value. See 06-security-architecture.md §5 (open redirect).
export function getSafeRedirectBase(origin?: string): string {
  const configured = getAppUrl();
  if (configured) return configured;
  if (process.env.NODE_ENV !== "production") {
    return origin ?? "";
  }
  return "";
}

// Mask an email for operator logs: keeps the first char + domain, redacts the
// rest. The audit log (DB) still stores the full value for investigation; this
// only applies to console output that may land in shared/aggregated logs.
// See 06-security-architecture.md §8 (data minimization) + §11 (never log full PII).
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
