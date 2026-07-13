import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  registerSchema,
  loginSchema,
  updateProfileSchema,
  programSchema,
  passwordSchema,
  forgotPasswordSchema,
} from "./validation";

// ====================================================================
// Unit tests for Zod validation schemas.
// These verify that the OTP-related schemas are gone, that the program
// dropdown enforces valid codes, and that the core auth schemas behave
// correctly.
// ====================================================================

describe("registerSchema", () => {
  const validInput = {
    email: "student@example.com",
    password: "StrongPass1!",
    fullName: "Jane Doe",
    studentId: 1234567,
    program: "BSIT",
    section: "1-A",
  };

  it("accepts a fully valid registration", () => {
    const result = registerSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("accepts registration without program (optional)", () => {
    const result = registerSchema.safeParse({ ...validInput, program: "" });
    expect(result.success).toBe(true);
    if (result.success) {
      // The schema transforms "" → null
      expect(result.data.program).toBeNull();
    }
  });

  it("rejects an invalid program code", () => {
    const result = registerSchema.safeParse({ ...validInput, program: "INVALID" });
    expect(result.success).toBe(false);
  });

  it("rejects a weak password (no number)", () => {
    const result = registerSchema.safeParse({ ...validInput, password: "WeakPassword" });
    expect(result.success).toBe(false);
  });

  it("rejects a weak password (no uppercase)", () => {
    const result = registerSchema.safeParse({ ...validInput, password: "weakpass1" });
    expect(result.success).toBe(false);
  });

  it("rejects a weak password (too short)", () => {
    const result = registerSchema.safeParse({ ...validInput, password: "Ab1" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid email", () => {
    const result = registerSchema.safeParse({ ...validInput, email: "not-an-email" });
    expect(result.success).toBe(false);
  });

  it("rejects a student ID that isn't 7 digits", () => {
    const result = registerSchema.safeParse({ ...validInput, studentId: 123 });
    expect(result.success).toBe(false);
  });

  it("rejects a name with numbers", () => {
    const result = registerSchema.safeParse({ ...validInput, fullName: "Jane Doe 123" });
    expect(result.success).toBe(false);
  });

  it("lowercases the email on parse", () => {
    const result = registerSchema.safeParse({ ...validInput, email: "STUDENT@EXAMPLE.COM" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("student@example.com");
    }
  });

  it("accepts all valid program codes", () => {
    for (const program of ["BSIT", "BSMx", "BIT-CT", "BIT-DT", "BIT-ET", "BIT-ELT"]) {
      const result = registerSchema.safeParse({ ...validInput, program });
      expect(result.success).toBe(true);
    }
  });
});

describe("loginSchema", () => {
  it("accepts a valid login", () => {
    const result = loginSchema.safeParse({
      email: "student@example.com",
      password: "anypassword",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty password", () => {
    const result = loginSchema.safeParse({
      email: "student@example.com",
      password: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid email", () => {
    const result = loginSchema.safeParse({
      email: "not-an-email",
      password: "password",
    });
    expect(result.success).toBe(false);
  });

  it("lowercases the email", () => {
    const result = loginSchema.safeParse({
      email: "STUDENT@EXAMPLE.COM",
      password: "password",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("student@example.com");
    }
  });
});

describe("updateProfileSchema", () => {
  const validInput = {
    fullName: "Jane Doe",
  };

  it("accepts a name-only update", () => {
    const result = updateProfileSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("accepts a name + valid program update", () => {
    const result = updateProfileSchema.safeParse({ ...validInput, program: "BSIT" });
    expect(result.success).toBe(true);
  });

  it("rejects an INVALID program code (must come from the dropdown)", () => {
    // This enforces server-side that the program comes from the dropdown,
    // not a free-text input.
    const result = updateProfileSchema.safeParse({ ...validInput, program: "HACKED" });
    expect(result.success).toBe(false);
  });

  it("accepts an empty program string (clearing the course)", () => {
    const result = updateProfileSchema.safeParse({ ...validInput, program: "" });
    expect(result.success).toBe(true);
  });

  it("accepts all valid program codes", () => {
    for (const program of ["BSIT", "BSMx", "BIT-CT", "BIT-DT", "BIT-ET", "BIT-ELT"]) {
      const result = updateProfileSchema.safeParse({ ...validInput, program });
      expect(result.success).toBe(true);
    }
  });

  it("accepts a valid year (1-6)", () => {
    for (const year of [1, 2, 3, 4, 5, 6]) {
      const result = updateProfileSchema.safeParse({ ...validInput, year });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an invalid year (0 or 7+)", () => {
    expect(updateProfileSchema.safeParse({ ...validInput, year: 0 }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ ...validInput, year: 7 }).success).toBe(false);
  });

  it("accepts a valid section (number-letter format)", () => {
    const result = updateProfileSchema.safeParse({ ...validInput, section: "2-B" });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid section (letter only, no number)", () => {
    const result = updateProfileSchema.safeParse({ ...validInput, section: "A" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid section (number only, no letter)", () => {
    const result = updateProfileSchema.safeParse({ ...validInput, section: "2" });
    expect(result.success).toBe(false);
  });

  it("rejects a name that's too short", () => {
    const result = updateProfileSchema.safeParse({ ...validInput, fullName: "A" });
    expect(result.success).toBe(false);
  });
});

describe("programSchema", () => {
  it("transforms empty string to null", () => {
    const result = programSchema.safeParse("");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeNull();
    }
  });

  it("accepts a valid program code", () => {
    const result = programSchema.safeParse("BSIT");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("BSIT");
    }
  });

  it("rejects an invalid program code", () => {
    const result = programSchema.safeParse("INVALID");
    expect(result.success).toBe(false);
  });

  it("accepts null (optional field)", () => {
    const result = programSchema.safeParse(null);
    expect(result.success).toBe(true);
  });

  it("accepts undefined (optional field)", () => {
    const result = programSchema.safeParse(undefined);
    expect(result.success).toBe(true);
  });
});

describe("passwordSchema", () => {
  it("accepts a strong password", () => {
    expect(passwordSchema.safeParse("StrongPass1!").success).toBe(true);
  });

  it("rejects a password without a number", () => {
    expect(passwordSchema.safeParse("StrongPass").success).toBe(false);
  });

  it("rejects a password without an uppercase letter", () => {
    expect(passwordSchema.safeParse("strongpass1").success).toBe(false);
  });

  it("rejects a password without a lowercase letter", () => {
    expect(passwordSchema.safeParse("STRONGPASS1").success).toBe(false);
  });

  it("rejects a password shorter than 8 characters", () => {
    expect(passwordSchema.safeParse("Ab1").success).toBe(false);
  });

  it("rejects a password longer than 128 characters", () => {
    const long = "Aa1!" + "x".repeat(125);
    expect(passwordSchema.safeParse(long).success).toBe(false);
  });
});

// ====================================================================
// OTP removal verification — these schemas should NOT exist anymore.
// If someone accidentally re-adds them, these tests will catch it.
// ====================================================================
describe("OTP removal verification", () => {
  it("the validation module does NOT export verifyOtpSchema", async () => {
    const mod = await import("./validation");
    expect((mod as Record<string, unknown>).verifyOtpSchema).toBeUndefined();
  });

  it("the validation module does NOT export resendOtpSchema", async () => {
    const mod = await import("./validation");
    expect((mod as Record<string, unknown>).resendOtpSchema).toBeUndefined();
  });

  it("the api-client module does NOT export useVerifyOtp", async () => {
    const mod = await import("./api-client");
    expect((mod as Record<string, unknown>).useVerifyOtp).toBeUndefined();
  });

  it("the api-client module does NOT export useResendOtp", async () => {
    const mod = await import("./api-client");
    expect((mod as Record<string, unknown>).useResendOtp).toBeUndefined();
  });
});

describe("forgotPasswordSchema — open-redirect defense", () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL;
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it("accepts a same-origin redirectTo when APP_URL is set", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://nexus.example.com";
    
    const r = forgotPasswordSchema.safeParse({
      email: "user@example.com",
      redirectTo: "https://nexus.example.com/reset?token=abc",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a cross-origin redirectTo (open-redirect block) when APP_URL is set", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://nexus.example.com";
    
    const r = forgotPasswordSchema.safeParse({
      email: "user@example.com",
      redirectTo: "https://evil.example.com/phish",
    });
    expect(r.success).toBe(false);
  });

  it("FAILS CLOSED: rejects all absolute redirectTo when APP_URL is unset (tautology fix)", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    
    // Previously this passed due to `parsed.origin === parsed.origin` tautology.
    const r = forgotPasswordSchema.safeParse({
      email: "user@example.com",
      redirectTo: "https://evil.example.com/phish",
    });
    expect(r.success).toBe(false);
  });

  it("still accepts when redirectTo is omitted (optional field)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://nexus.example.com";
    
    const r = forgotPasswordSchema.safeParse({
      email: "user@example.com",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a malformed redirectTo URL", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://nexus.example.com";

    const r = forgotPasswordSchema.safeParse({
      email: "user@example.com",
      redirectTo: "not-a-url",
    });
    expect(r.success).toBe(false);
  });

  it("accepts a relative path redirectTo (inherently same-origin)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://nexus.example.com";

    const r = forgotPasswordSchema.safeParse({
      email: "user@example.com",
      redirectTo: "/reset-password?token=abc",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a relative path redirectTo even when APP_URL is unset", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;

    const r = forgotPasswordSchema.safeParse({
      email: "user@example.com",
      redirectTo: "/reset-password",
    });
    expect(r.success).toBe(true);
  });
});
