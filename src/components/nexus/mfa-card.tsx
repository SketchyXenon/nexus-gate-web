"use client";

// Nexus Gate - MFA (TOTP) Card
// --------------------------------------------------------------------
// Profile view card for self-service MFA enrollment + disable.
// Mirrors the existing Passkey card pattern in profile.tsx.
//
// States:
//   - Not enrolled: "Set up MFA" button -> enroll dialog (QR + secret +
//     6-digit OTP input + verify button).
//   - Verify success: 10 backup codes shown once + warning + copy all.
//   - Enrolled, idle: "Enabled since {date}" + "Disable MFA" button
//     (opens confirm dialog requiring a current TOTP or backup code).
//
// Per 06-security-architecture.md §2 "defense in depth". Uses vetted
// libraries: otplib (server), qrcode.react (QR), input-otp (UI),
// bcrypt (backup codes), jose (challenge/verified JWTs). No custom
// crypto.

import { useState } from "react";
import {
  ShieldCheck,
  Loader2,
  Copy,
  Check,
  AlertCircle,
  KeyRound,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { QRCodeCanvas } from "qrcode.react";
import {
  useMfaStatus,
  useMfaEnroll,
  useMfaVerify,
  useMfaDisable,
} from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { format } from "date-fns";

export function MfaCard() {
  const { data, isLoading } = useMfaStatus();
  const enabled = data?.enabled === true;
  const enabledAt = data?.enabledAt;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-primary" /> Two-factor
          authentication
        </CardTitle>
        <CardDescription>
          Add an extra one-time code from your authenticator app at sign-in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading MFA status…
          </div>
        ) : enabled ? (
          <EnrolledView enabledAt={enabledAt} />
        ) : (
          <NotEnrolledView />
        )}
      </CardContent>
    </Card>
  );
}

// ---- Not enrolled: enroll dialog (QR + OTP input) ----
function NotEnrolledView() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        className="w-full"
        onClick={() => setOpen(true)}
      >
        <ShieldCheck className="h-4 w-4" />
        Set up MFA
      </Button>
      <EnrollDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function EnrollDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const enroll = useMfaEnroll();
  const verify = useMfaVerify();
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  // Trigger enroll when the dialog opens (only once per open).
  const [startedForOpen, setStartedForOpen] = useState(false);
  if (open && !startedForOpen && !enroll.data && !enroll.isPending) {
    setStartedForOpen(true);
    enroll.mutate(undefined, {
      onError: (err) =>
        toast({
          title: "Couldn't start MFA enrollment",
          description: err.message,
          variant: "destructive",
        }),
    });
  }
  if (!open && startedForOpen) {
    // Reset state when the dialog closes so reopening starts fresh.
    setStartedForOpen(false);
    setCode("");
    setBackupCodes(null);
    enroll.reset();
    verify.reset();
  }

  const secret = enroll.data?.secret;
  const otpauthUrl = enroll.data?.otpauthUrl;

  function handleVerify() {
    if (!code || code.replace(/\s/g, "").length !== 6) {
      toast({
        title: "Enter the 6-digit code",
        description: "From your authenticator app.",
        variant: "destructive",
      });
      return;
    }
    verify.mutate(
      { code },
      {
        onSuccess: (data) => {
          setBackupCodes(data.backupCodes);
          toast({
            title: "MFA enabled",
            description: "Save your backup codes - you'll need them if you lose your device.",
          });
        },
        onError: (err) =>
          toast({
            title: "Verification failed",
            description: err.message,
            variant: "destructive",
          }),
      },
    );
  }

  function handleCopyAll() {
    if (!backupCodes) return;
    void navigator.clipboard.writeText(backupCodes.join("\n"));
    toast({ title: "Backup codes copied to clipboard" });
  }

  function handleClose() {
    onOpenChange(false);
    // If MFA was just enabled, the user's session is no longer
    // sufficient (mfaEnabled=true, no ng_mfa_verified cookie). The
    // next requireAuth-protected call returns 401. Hard-reload to the
    // login screen so they can complete MFA on the new sign-in.
    if (backupCodes) {
      setTimeout(() => {
        void fetch("/api/auth/logout", { method: "POST" }).finally(() => {
          window.location.replace("/");
        });
      }, 250);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); else onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {backupCodes ? "Save your backup codes" : "Set up two-factor authentication"}
          </DialogTitle>
          <DialogDescription>
            {backupCodes
              ? "These codes work once each. Store them somewhere safe - you'll need one if you ever lose your authenticator device."
              : "Scan the QR with Google Authenticator, 1Password, Authy, or any TOTP app, then enter the 6-digit code."}
          </DialogDescription>
        </DialogHeader>

        {backupCodes ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5 rounded-lg border p-3 bg-muted/30">
              {backupCodes.map((c) => (
                <code
                  key={c}
                  className="text-xs font-mono text-center py-1 rounded bg-background"
                >
                  {c}
                </code>
              ))}
            </div>
            <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                Store these safely. Each works once. We won&apos;t show them again.
              </span>
            </div>
            <Button onClick={handleCopyAll} variant="outline" className="w-full">
              <Copy className="h-4 w-4" /> Copy all codes
            </Button>
            <Button onClick={handleClose} className="w-full">
              <Check className="h-4 w-4" /> I&apos;ve saved them
            </Button>
          </div>
        ) : enroll.isPending || !secret ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-lg border bg-white p-2">
                <QRCodeCanvas
                  value={otpauthUrl || "pending"}
                  size={200}
                  level="M"
                  marginSize={2}
                  fgColor="#0c1a17"
                  bgColor="#ffffff"
                />
              </div>
              <details className="text-xs text-muted-foreground w-full">
                <summary className="cursor-pointer select-none">
                  Can&apos;t scan? Enter the secret manually.
                </summary>
                <div className="mt-2 flex items-center gap-2">
                  <code className="flex-1 font-mono text-[11px] break-all rounded border p-2 bg-muted/30">
                    {secret}
                  </code>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard.writeText(secret);
                      toast({ title: "Secret copied" });
                    }}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
              </details>
            </div>

            <div className="space-y-2">
              <Label htmlFor="mfa-enroll-code">Enter the 6-digit code</Label>
              <InputOTP
                id="mfa-enroll-code"
                maxLength={6}
                value={code}
                onChange={(v) => setCode(v)}
                onComplete={(v) => setCode(v)}
                containerClassName="justify-center"
              >
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>

            <Button
              type="button"
              className="w-full"
              disabled={verify.isPending || code.length !== 6}
              onClick={handleVerify}
            >
              {verify.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              Enable MFA
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- Enrolled, idle: show date + disable button ----
function EnrolledView({ enabledAt }: { enabledAt: string | null }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <ShieldCheck className="h-4 w-4 text-emerald-500" />
        <span className="font-medium">Enabled</span>
        {enabledAt && (
          <span className="text-muted-foreground">
            since {format(new Date(enabledAt), "MMM d, yyyy")}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        You&apos;ll be asked for a 6-digit code from your authenticator app at
        every sign-in. Keep your backup codes safe.
      </p>
      <Button
        variant="outline"
        className="w-full"
        onClick={() => setConfirmOpen(true)}
      >
        <KeyRound className="h-4 w-4" />
        Disable MFA
      </Button>
      <DisableDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
      />
    </div>
  );
}

function DisableDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const disable = useMfaDisable();
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);

  function handleDisable() {
    if (!code) {
      toast({
        title: "Enter a code",
        description: "Your current TOTP or a backup code.",
        variant: "destructive",
      });
      return;
    }
    disable.mutate(
      { code },
      {
        onSuccess: () => {
          toast({ title: "MFA disabled" });
          setCode("");
          setUseBackup(false);
          onOpenChange(false);
        },
        onError: (err) =>
          toast({
            title: "Couldn't disable MFA",
            description: err.message,
            variant: "destructive",
          }),
      },
    );
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setCode("");
          setUseBackup(false);
          disable.reset();
        }
        onOpenChange(v);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disable two-factor authentication?</AlertDialogTitle>
          <AlertDialogDescription>
            Enter your current 6-digit TOTP code (or a backup code) to confirm.
            Your account will only need a password at sign-in after this.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              className={`px-2 py-1 rounded ${!useBackup ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground"}`}
              onClick={() => setUseBackup(false)}
            >
              Authenticator code
            </button>
            <button
              type="button"
              className={`px-2 py-1 rounded ${useBackup ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground"}`}
              onClick={() => setUseBackup(true)}
            >
              Backup code
            </button>
          </div>
          {useBackup ? (
            <Input
              placeholder="XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              className="font-mono"
            />
          ) : (
            <InputOTP
              maxLength={6}
              value={code}
              onChange={(v) => setCode(v)}
              containerClassName="justify-center"
            >
              <InputOTPGroup>
                <InputOTPSlot index={0} />
                <InputOTPSlot index={1} />
                <InputOTPSlot index={2} />
                <InputOTPSlot index={3} />
                <InputOTPSlot index={4} />
                <InputOTPSlot index={5} />
              </InputOTPGroup>
            </InputOTP>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleDisable();
            }}
            disabled={disable.isPending || !code}
          >
            {disable.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : null}
            Disable MFA
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

