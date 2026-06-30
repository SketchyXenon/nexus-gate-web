// ====================================================================
// Method 4 adaptation — Browser Device Fingerprint Account Bonding.
// Generates a stable per-browser deviceId (canvas + UA + screen + RNG
// seeded once, persisted in localStorage). Sent at login to bind the
// account to this browser; the server enforces uniqueness so the same
// fingerprint cannot be shared across accounts.
// ====================================================================

const STORAGE_KEY = "ng_device_id";

function canvasFingerprint(): string {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 220;
    canvas.height = 30;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "no-canvas";
    ctx.textBaseline = "top";
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = "#f60";
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = "#069";
    ctx.fillText("Nexus-Gate:CTU-Danao", 2, 15);
    return canvas.toDataURL();
  } catch {
    return "canvas-err";
  }
}

function rawFingerprint(): string {
  const parts = [
    navigator.userAgent,
    navigator.language,
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    String(navigator.hardwareConcurrency || 0),
    String((navigator as unknown as { deviceMemory?: number }).deviceMemory || 0),
    new Date().getTimezoneOffset().toString(),
    canvasFingerprint(),
  ];
  return parts.join("|");
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function getDeviceId(): Promise<string> {
  if (typeof window === "undefined") return "ssr";
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) return existing;
  const id = await sha256Hex(rawFingerprint() + crypto.randomUUID());
  localStorage.setItem(STORAGE_KEY, id);
  return id;
}
