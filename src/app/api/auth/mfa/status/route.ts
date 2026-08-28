// GET /api/auth/mfa/status
// Returns the current MFA state for the signed-in user. Used by the
// Profile UI to decide whether to render the "Set up MFA" button or
// the "Disable MFA" button. Requires auth (any role).
import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/api";

export async function GET(_req: NextRequest) {
  const res = await requireAuth();
  if ("error" in res) return res.error;
  const { account } = res;

  // mfaEnabled/mfaEnabledAt are optional on ApiAccount (defensive for
  // the case where the MFA migration isn't applied - they default to
  // false/null, which the UI treats as "not enrolled").
  const mfaEnabled = (account as { mfaEnabled?: boolean }).mfaEnabled === true;
  const mfaEnabledAtRaw = (account as { mfaEnabledAt?: string | null })
    .mfaEnabledAt;
  return NextResponse.json(
    {
      enabled: mfaEnabled,
      enabledAt: mfaEnabledAtRaw ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
