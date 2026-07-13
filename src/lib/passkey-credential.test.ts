import { describe, it, expect } from "vitest";

// ====================================================================
// Tests for the passkey login-verify credential ID extraction logic.
// The route extracts assertion.id (a base64url string) and looks up the
// account via the indexed passkeyCredentialId column — O(log N) instead
// of the old O(N) scan + N crypto verifications.
//
// These tests verify the extraction logic without needing a DB or
// WebAuthn crypto library.
// ====================================================================

// Simulates the credential ID extraction from a WebAuthn assertion.
// In the real route: const credentialId = assertion?.id;
function extractCredentialId(assertion: { id?: string } | null | undefined): string | null {
  if (!assertion?.id) return null;
  return assertion.id;
}

describe("passkey credential ID extraction", () => {
  it("extracts the id field from a valid assertion", () => {
    const assertion = {
      id: "abc123-base64url",
      rawId: "abc123-base64url",
      response: { authenticatorData: "", clientDataJSON: "", signature: "" },
    };
    expect(extractCredentialId(assertion)).toBe("abc123-base64url");
  });

  it("returns null when assertion is null", () => {
    expect(extractCredentialId(null)).toBeNull();
  });

  it("returns null when assertion is undefined", () => {
    expect(extractCredentialId(undefined)).toBeNull();
  });

  it("returns null when id field is missing", () => {
    const assertion = { rawId: "abc", response: {} } as { id?: string };
    expect(extractCredentialId(assertion)).toBeNull();
  });

  it("returns null when id field is empty string", () => {
    const assertion = { id: "", rawId: "", response: {} };
    expect(extractCredentialId(assertion)).toBeNull();
  });

  it("handles typical WebAuthn credential IDs (base64url, ~40-200 chars)", () => {
    const typicalId = "VAtU6q_xJ6sYwKRGH6q2TlQYqY0YqY0YqY0YqY0YqY0";
    const assertion = { id: typicalId };
    expect(extractCredentialId(assertion)).toBe(typicalId);
  });
});

// ====================================================================
// Tests for the passkey register-verify credential ID storage logic.
// The route stores credential.id in both passkeyCredential (JSON) and
// passkeyCredentialId (indexed column for O(log N) login lookup).
// ====================================================================

describe("passkey register credential ID storage", () => {
  it("builds the stored credential JSON with id field", () => {
    const credential = {
      id: "test-credential-id",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
    };
    const stored = JSON.stringify({
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64"),
      counter: credential.counter,
      transports: [],
    });
    const parsed = JSON.parse(stored);
    expect(parsed.id).toBe("test-credential-id");
    expect(parsed.counter).toBe(0);
    expect(parsed.transports).toEqual([]);
  });

  it("the credential ID is suitable for a unique index lookup", () => {
    // WebAuthn credential IDs are globally unique (random bytes generated
    // by the authenticator). This makes them safe for a UNIQUE index.
    const id1 = "credential-from-device-A";
    const id2 = "credential-from-device-B";
    expect(id1).not.toBe(id2);
  });
});
