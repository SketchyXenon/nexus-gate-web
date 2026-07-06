import type { NextRequest } from "next/server";

export function isAuthorizedCronRequest(req: NextRequest): boolean {
  const cronSecret = (process.env.CRON_SECRET || "").trim();
  if (!cronSecret) {
    return false;
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token === cronSecret) return true;
  }

  const headerSecret = (
    req.headers.get("x-cron-secret") ||
    req.headers.get("x-cronjob-secret") ||
    ""
  ).trim();
  if (headerSecret && headerSecret === cronSecret) return true;

  const url = new URL(req.url);
  const querySecret = (
    url.searchParams.get("secret") ||
    url.searchParams.get("cron_secret") ||
    url.searchParams.get("token") ||
    ""
  ).trim();
  if (querySecret && querySecret === cronSecret) return true;

  return false;
}
