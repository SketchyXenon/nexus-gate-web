// ====================================================================
// Nexus Gate — Password strength scorer (pure, unit-tested)
// ====================================================================
// This module is shared between:
//   - The SERVER (Zod schema in validation.ts enforces a minimum score)
//   - The CLIENT (PasswordStrengthMeter shows the score visually)
//
// Because the SAME scoring function runs on both sides, the client
// meter accurately reflects what the server will accept. A user cannot
// bypass the strength requirement by modifying the client — the server
// re-runs the exact same check and rejects weak passwords with
// "Password is not strong enough."
// ====================================================================

export interface PasswordScore {
  /** 0–6 raw score */
  score: number;
  /** 0–100 percentage for the meter bar */
  percent: number;
  /** Human-readable label */
  label: "Empty" | "Weak" | "Fair" | "Good" | "Strong";
  /** Color class for the meter bar (Tailwind) */
  color:
    | ""
    | "bg-red-500"
    | "bg-amber-500"
    | "bg-yellow-500"
    | "bg-emerald-500";
  /** Missing requirements (for the "Needs: …" hint) */
  tips: string[];
  /** True if the password meets the MINIMUM strength required by the server */
  passes: boolean;
}

/** Minimum score (out of 6) required for the server to accept a password. */
export const MIN_PASSWORD_SCORE = 4;

/**
 * Score a password's strength on a 0–6 scale.
 *
 * Criteria (1 point each):
 *   1. Length ≥ 8
 *   2. Length ≥ 12 (bonus for longer passwords)
 *   3. Contains an uppercase letter
 *   4. Contains a lowercase letter
 *   5. Contains a digit
 *   6. Contains a special character
 *
 * Penalty: if the password starts with a common pattern
 * (password, 123456, qwerty, abc), 2 points are deducted.
 *
 * A password must score at least MIN_PASSWORD_SCORE (4) to be accepted
 * by the server. This means it must meet the basic 4 criteria: length ≥ 8,
 * uppercase, lowercase, digit — PLUS at least one of {length ≥ 12, special
 * character}. Effectively this requires a "Good" or "Strong" password.
 */
export function scorePassword(password: string): PasswordScore {
  if (!password) {
    return {
      score: 0,
      percent: 0,
      label: "Empty",
      color: "",
      tips: [],
      passes: false,
    };
  }

  let s = 0;
  const tips: string[] = [];

  // 1. Length ≥ 8
  if (password.length >= 8) s += 1;
  else tips.push("8+ characters");

  // 2. Length ≥ 12 (bonus)
  if (password.length >= 12) s += 1;
  else tips.push("12+ characters for a stronger password");

  // 3. Uppercase
  if (/[A-Z]/.test(password)) s += 1;
  else tips.push("uppercase letter");

  // 4. Lowercase
  if (/[a-z]/.test(password)) s += 1;
  else tips.push("lowercase letter");

  // 5. Digit
  if (/[0-9]/.test(password)) s += 1;
  else tips.push("number");

  // 6. Special character
  if (/[^A-Za-z0-9]/.test(password)) s += 1;
  else tips.push("special character");

  // Penalty for common patterns — expanded list of obvious passwords.
  if (
    /^(password|passw0rd|123456|123123|qwerty|letmein|welcome|admin|admin123|monkey|iloveyou|111111|000000|abc123|1q2w3e|asdf|zxcv)/i.test(
      password,
    )
  ) {
    s = Math.max(0, s - 2);
  }

  // Penalty for 3+ sequential chars (1234, abcd, qwerty).
  if (hasSequential(password)) {
    s = Math.max(0, s - 1);
  }

  // Penalty for 4+ repeated chars (aaaa, 1111).
  if (/(.)\1\1\1/.test(password)) {
    s = Math.max(0, s - 1);
  }

  const maxScore = 6;
  const percent = Math.min(100, (s / maxScore) * 100);

  let label: PasswordScore["label"];
  let color: PasswordScore["color"];
  if (s <= 2) {
    label = "Weak";
    color = "bg-red-500";
  } else if (s <= 3) {
    label = "Fair";
    color = "bg-amber-500";
  } else if (s <= 4) {
    label = "Good";
    color = "bg-yellow-500";
  } else {
    label = "Strong";
    color = "bg-emerald-500";
  }

  return {
    score: s,
    percent,
    label,
    color,
    tips,
    passes: s >= MIN_PASSWORD_SCORE,
  };
}

// Detect 3+ consecutive sequential chars (ascending or descending).
// Checks both alpha (abcd, dcba) and numeric (1234, 4321) sequences.
function hasSequential(password: string): boolean {
  const lower = password.toLowerCase();
  for (let i = 0; i + 2 < lower.length; i++) {
    const a = lower.charCodeAt(i);
    const b = lower.charCodeAt(i + 1);
    const c = lower.charCodeAt(i + 2);
    if (b - a === 1 && c - b === 1) return true; // ascending
    if (a - b === 1 && b - c === 1) return true; // descending
  }
  return false;
}
