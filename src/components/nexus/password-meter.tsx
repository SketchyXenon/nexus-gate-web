"use client";

import { useMemo } from "react";
import { CheckCircle2 } from "lucide-react";
import { scorePassword } from "@/lib/password-strength";

// Password strength indicator. Uses the SAME scorePassword() as the server.
// When the password passes (score >= 4), collapses to a clean green badge
// so the UI stays uncluttered. Otherwise shows the bar + missing requirements.

interface Props {
  password: string;
}

export function PasswordStrengthMeter({ password }: Props) {
  const { score, percent, label, color, tips, passes } = useMemo(
    () => scorePassword(password),
    [password]
  );

  if (!password) return null;

  // Clean "good password" flag when requirements are met.
  if (passes) {
    return (
      <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5 transition-opacity duration-200" />
        <span className="text-[11px] font-medium">
          {score >= 5 ? "Strong password" : "Good password"}
        </span>
      </div>
    );
  }

  // Otherwise show the bar + label + missing requirements (compact).
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
            score >= 4
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
        <p className="text-[10px] text-muted-foreground">
          Needs: {tips.join(", ")}
        </p>
      )}
    </div>
  );
}
