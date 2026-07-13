import { describe, it, expect } from "vitest";
import { scorePassword, MIN_PASSWORD_SCORE } from "./password-strength";

// ====================================================================
// Unit tests for the password strength scorer.
// This is the SAME function used by the server (Zod schema) and the
// client (meter), so these tests verify the exact behavior the server
// will enforce.
// ====================================================================

describe("scorePassword", () => {
  // ---- Empty password ----
  it("returns score 0 for an empty string", () => {
    const result = scorePassword("");
    expect(result.score).toBe(0);
    expect(result.percent).toBe(0);
    expect(result.label).toBe("Empty");
    expect(result.passes).toBe(false);
  });

  // ---- Weak passwords (score < MIN_PASSWORD_SCORE) ----
  describe("weak passwords (should NOT pass)", () => {
    const weakPasswords: Array<{ pw: string; reason: string }> = [
      { pw: "Ab1", reason: "too short (no length point, no 12+ point, no special)" },
      { pw: "abcdefgh", reason: "no uppercase, no number, no special" },
      { pw: "ABCDEFGH", reason: "no lowercase, no number, no special" },
      { pw: "12345678", reason: "no letters, no special" },
      { pw: "Xk7mP2q9", reason: "8 chars + upper + lower + digit = 4, but no 12+ and no special → 4 (borderline, see below)" },
    ];

    for (const { pw, reason } of weakPasswords) {
      it(`"${pw}" — ${reason}`, () => {
        const result = scorePassword(pw);
        // These should either fail or be exactly at the boundary
        if (pw === "Xk7mP2q9") {
          // 8 chars (1) + upper (1) + lower (1) + digit (1) = 4 → passes (boundary)
          expect(result.score).toBe(4);
          expect(result.passes).toBe(true);
        } else {
          expect(result.passes).toBe(false);
        }
      });
    }
  });

  // ---- Strong passwords (score >= MIN_PASSWORD_SCORE) ----
  describe("strong passwords (should pass)", () => {
    const strongPasswords: Array<{ pw: string; reason: string }> = [
      { pw: "Xk7mP2q!", reason: "8 chars + upper + lower + digit + special = 5" },
      { pw: "StrongPass1!", reason: "12 chars + upper + lower + digit + special = 6" },
      { pw: "MyP@ssw0rd2024", reason: "14 chars + upper + lower + digit + special = 6" },
      { pw: "XkmPqxzLL3jN", reason: "13 chars + upper + lower + digit = 5 (no special but 12+)" },
    ];

    for (const { pw, reason } of strongPasswords) {
      it(`"${pw}" passes — ${reason}`, () => {
        const result = scorePassword(pw);
        expect(result.passes).toBe(true);
        expect(result.score).toBeGreaterThanOrEqual(MIN_PASSWORD_SCORE);
      });
    }
  });

  // ---- Common pattern penalty ----
  describe("common pattern penalty", () => {
    it("deducts 2 points for 'password' prefix", () => {
      const normal = scorePassword("Strong1!");
      const withPattern = scorePassword("passwordStrong1!");
      expect(withPattern.score).toBeLessThan(normal.score);
    });

    it("deducts 2 points for '123456' prefix", () => {
      const result = scorePassword("123456Ab!");
      expect(result.score).toBeLessThanOrEqual(4);
    });

    it("deducts 2 points for 'qwerty' prefix", () => {
      const result = scorePassword("qwertyAb!");
      expect(result.score).toBeLessThanOrEqual(4);
    });

    it("never goes below 0", () => {
      const result = scorePassword("password");
      expect(result.score).toBeGreaterThanOrEqual(0);
    });
  });

  // ---- Score breakdown verification ----
  describe("score breakdown", () => {
    it("awards 1 point for length >= 8", () => {
      const r = scorePassword("Xk7mP2q9"); // 8 chars
      // 8 chars (1) + upper (1) + lower (1) + digit (1) = 4, no 12+, no special
      expect(r.score).toBe(4);
    });

    it("awards 1 point for length >= 12", () => {
      const r = scorePassword("XkmPqxzLL3jN"); // 13 chars
      // 8+ (1) + 12+ (1) + upper (1) + lower (1) + digit (1) = 5, no special
      expect(r.score).toBe(5);
    });

    it("awards 1 point for uppercase", () => {
      const r = scorePassword("Xk7mP2q!");
      expect(r.score).toBeGreaterThanOrEqual(5);
    });

    it("awards 1 point for lowercase", () => {
      const r = scorePassword("XK7M2Q$T");
      // 8+ (1) + 12? no + upper (1) + lower? no + digit (1) + special (1) = 4
      expect(r.score).toBe(4);
    });

    it("awards 1 point for a digit", () => {
      const r = scorePassword("Xk$mPqxz");
      // 8+ (1) + 12? no + upper (1) + lower (1) + digit? no + special (1) = 4
      expect(r.score).toBe(4);
    });

    it("awards 1 point for a special character", () => {
      const r = scorePassword("Xk7mP2q!");
      // 8+ (1) + 12? no + upper (1) + lower (1) + digit (1) + special (1) = 5
      expect(r.score).toBe(5);
    });
  });

  // ---- Labels ----
  describe("labels", () => {
    it("returns 'Empty' for empty string", () => {
      expect(scorePassword("").label).toBe("Empty");
    });

    it("returns 'Weak' for score <= 2", () => {
      expect(scorePassword("ab").label).toBe("Weak");
    });

    it("returns 'Fair' for score 3", () => {
      expect(scorePassword("XkmPqxzL").label).toBe("Fair"); // 8+ upper lower = 3
    });

    it("returns 'Good' for score 4", () => {
      expect(scorePassword("Xk7mP2q9").label).toBe("Good"); // 4
    });

    it("returns 'Strong' for score >= 5", () => {
      expect(scorePassword("Xk7mP2q!").label).toBe("Strong"); // 5
      expect(scorePassword("StrongPass1!").label).toBe("Strong"); // 6
    });
  });

  // ---- Tips ----
  describe("tips", () => {
    it("includes '8+ characters' when too short", () => {
      const r = scorePassword("Ab1!");
      expect(r.tips).toContain("8+ characters");
    });

    it("includes 'uppercase letter' when missing", () => {
      const r = scorePassword("abcdefg1!");
      expect(r.tips).toContain("uppercase letter");
    });

    it("includes 'lowercase letter' when missing", () => {
      const r = scorePassword("XK7M2Q$T");
      expect(r.tips).toContain("lowercase letter");
    });

    it("includes 'number' when missing", () => {
      const r = scorePassword("Xk$mPqxz");
      expect(r.tips).toContain("number");
    });

    it("includes 'special character' when missing", () => {
      const r = scorePassword("Xk7mP2q9");
      expect(r.tips).toContain("special character");
    });

    it("includes '12+ characters' hint when under 12", () => {
      const r = scorePassword("Xk7mP2q!");
      expect(r.tips).toContain("12+ characters for a stronger password");
    });
  });

  // ---- MIN_PASSWORD_SCORE constant ----
  describe("MIN_PASSWORD_SCORE", () => {
    it("is 4", () => {
      expect(MIN_PASSWORD_SCORE).toBe(4);
    });
  });

  // ---- passes flag ----
  describe("passes flag", () => {
    it("is false for scores below MIN_PASSWORD_SCORE", () => {
      expect(scorePassword("").passes).toBe(false);
      expect(scorePassword("ab").passes).toBe(false);
      expect(scorePassword("XkmPqxzL").passes).toBe(false); // score 3
    });

    it("is true for scores at or above MIN_PASSWORD_SCORE", () => {
      expect(scorePassword("Xk7mP2q9").passes).toBe(true); // score 4
      expect(scorePassword("Xk7mP2q!").passes).toBe(true); // score 5
      expect(scorePassword("StrongPass1!").passes).toBe(true); // score 6
    });
  });
});
