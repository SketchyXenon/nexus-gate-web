import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Helpers to build a fake NextRequest with headers.
function makeReq(
  headers: Record<string, string> = {},
  url = "http://localhost:3000/api/auth/passkey/login-options",
): NextRequest {
  const req = {
    nextUrl: new URL(url),
    headers: new Headers(headers),
  } as unknown as NextRequest;
  return req;
}

describe("getWebAuthnContext — RP ID / origin resolution", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it("uses NEXT_PUBLIC_APP_URL when set (canonical production URL)", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://nexus-gate.ctu.edu.ph";
    const { getWebAuthnContext } = await import("@/lib/webauthn-context");
    const ctx = getWebAuthnContext(makeReq());
    expect(ctx.rpID).toBe("nexus-gate.ctu.edu.ph");
    expect(ctx.expectedOrigin).toBe("https://nexus-gate.ctu.edu.ph");
  });

  it("falls back to X-Forwarded-Host + X-Forwarded-Proto when no APP_URL", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const { getWebAuthnContext } = await import("@/lib/webauthn-context");
    const req = makeReq({
      "x-forwarded-host": "preview.sandbox.dev",
      "x-forwarded-proto": "https",
    });
    const ctx = getWebAuthnContext(req);
    expect(ctx.rpID).toBe("preview.sandbox.dev");
    expect(ctx.expectedOrigin).toBe("https://preview.sandbox.dev");
  });

  it("uses first host in a comma-separated X-Forwarded-Host chain", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const { getWebAuthnContext } = await import("@/lib/webauthn-context");
    const req = makeReq({
      "x-forwarded-host": "public.example.com, internal.proxy.local",
      "x-forwarded-proto": "https",
    });
    const ctx = getWebAuthnContext(req);
    expect(ctx.rpID).toBe("public.example.com");
  });

  it("falls back to direct Host header when no APP_URL and no forwarded host", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const { getWebAuthnContext } = await import("@/lib/webauthn-context");
    const req = makeReq({ host: "localhost:3000" });
    const ctx = getWebAuthnContext(req);
    expect(ctx.rpID).toBe("localhost");
    expect(ctx.expectedOrigin).toBe("http://localhost:3000");
  });

  it("APP_URL takes priority over forwarded host (prevents spoofing)", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://real.example.com";
    const { getWebAuthnContext } = await import("@/lib/webauthn-context");
    const req = makeReq({
      "x-forwarded-host": "attacker.example.com",
      "x-forwarded-proto": "https",
    });
    const ctx = getWebAuthnContext(req);
    expect(ctx.rpID).toBe("real.example.com");
  });

  it("strips port from rpID (WebAuthn RP ID is hostname only)", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://nexus.example.com:8443";
    const { getWebAuthnContext } = await import("@/lib/webauthn-context");
    const ctx = getWebAuthnContext(makeReq());
    expect(ctx.rpID).toBe("nexus.example.com");
  });

  it("handles malformed APP_URL gracefully (falls through)", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "not-a-url";
    const { getWebAuthnContext } = await import("@/lib/webauthn-context");
    const req = makeReq({ host: "fallback.example.com" });
    const ctx = getWebAuthnContext(req);
    expect(ctx.rpID).toBe("fallback.example.com");
  });

  it("last-resort fallback to req.nextUrl when no headers or env", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const { getWebAuthnContext } = await import("@/lib/webauthn-context");
    const ctx = getWebAuthnContext(makeReq({}));
    // req.nextUrl is http://localhost:3000/...
    expect(ctx.rpID).toBe("localhost");
    expect(ctx.expectedOrigin).toBe("http://localhost:3000");
  });
});
