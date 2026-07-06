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
