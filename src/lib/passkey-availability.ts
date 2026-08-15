"use client";

// ====================================================================
// Nexus Gate — Passkey availability detection (CLIENT-SIDE)
// --------------------------------------------------------------------
// Hybrid UX helper: detects whether the current browser/device can create
// and use passkeys, and whether a platform authenticator (Face ID / Windows
// Hello / fingerprint) is available. Used by the login screen and profile
// page to decide whether to show the passkey button and which fallback to
// offer when WebAuthn is unavailable.
//
// Per 05-ui-ux-design.md §6 (feedback): give the user a clear, actionable
// next step rather than a cryptic failure. Per 06-security-architecture.md
// §2: passkeys are a possession+biometric factor; if the platform lacks an
// authenticator, we must NOT silently downgrade — we surface a clear message.
// ====================================================================

export type PasskeySupport =
  | { supported: true; platformAuthenticator: boolean }
  | { supported: false; reason: "insecure-context" | "unavailable" };

/**
 * Detect passkey (WebAuthn) support on the current device.
 *
 * - Returns `supported: false` if window.PublicKeyCredential is undefined
 *   (legacy browser) OR the page is served over http (not https) outside
 *   localhost — WebAuthn requires a secure context.
 * - `platformAuthenticator: true` means a built-in authenticator (biometric /
 *   PIN) is enrolled. If false, the user can still use a roaming authenticator
 *   (USB key) or the cross-device (phone QR) flow, but we won't auto-prompt.
 */
export async function detectPasskeySupport(): Promise<PasskeySupport> {
  if (
    typeof window === "undefined" ||
    typeof window.PublicKeyCredential === "undefined"
  ) {
    return { supported: false, reason: "unavailable" };
  }
  // Secure context check: WebAuthn requires https or localhost.
  if (!window.isSecureContext) {
    return { supported: false, reason: "insecure-context" };
  }
  let platformAuthenticator = false;
  try {
    if (
      typeof window.PublicKeyCredential
        .isUserVerifyingPlatformAuthenticatorAvailable === "function"
    ) {
      platformAuthenticator =
        await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    }
  } catch {
    platformAuthenticator = false;
  }
  return { supported: true, platformAuthenticator };
}

/**
 * Human-readable explanation for the "no passkey" state, with an actionable
 * next step (per 05-ui-ux-design.md §6: state what happened and what to do next).
 */
export function passkeyUnavailableMessage(
  reason: "insecure-context" | "unavailable",
): string {
  if (reason === "insecure-context") {
    return "Passkeys require a secure (HTTPS) connection. Use the app over HTTPS to enable passkey sign-in.";
  }
  return "This browser doesn't support passkeys. Update your browser, or sign in with your email and password.";
}
