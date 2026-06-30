"use client";

import { useMemo } from "react";
import { scorePassword } from "@/lib/password-strength";

// ====================================================================
// Password Strength Meter — visual indicator with color-coded bar
// and text label. Uses the SAME scorePassword() function as the server,
// so the meter accurately reflects what the server will accept.
// ====================================================================

interface Props {
  password: string;
}

export function PasswordStrengthMeter({ password }: Props) {
  const { score, percent, label, color, tips, passes } = useMemo(
    () => scorePassword(password),
    [password]
  );

  if (!password) return null;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${color}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <span
          className={`text-[10px] font-medium tabular-nums ${
            score > 4
              ? "text-emerald-600"
              : score >= 4
              ? "text-yellow-600"
              : score >= 3
              ? "text-amber-600"
              : "text-red-500"
          }`}
        >
          {label}
        </span>
      </div>
      {tips.length > 0 && (
        <p className="text-[10px] text-muted-foreground">Needs: {tips.join(", ")}</p>
      )}
      {!passes && tips.length === 0 && (
        <p className="text-[10px] text-amber-600">
          Add a special character or use 12+ characters to strengthen your password.
        </p>
      )}
    </div>
  );
}
