export function getAppUrl(): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!appUrl) {
    throw new Error("NEXT_PUBLIC_APP_URL is required.");
  }
  return appUrl;
}
