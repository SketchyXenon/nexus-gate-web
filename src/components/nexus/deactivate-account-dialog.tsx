"use client";

import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle,
  Loader2,
  ShieldAlert,
  UserX,
} from "lucide-react";
import { useDeactivateAccount } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";

interface DeactivateAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email: string;
}

// Double-confirmation account deactivation dialog.
//
// Step 1: Initial warning - "Are you sure?" with a brief description.
// Step 2: Final warning - lists ALL consequences, requires typing
//         "DEACTIVATE" AND entering the current password.
//
// This is a SOFT DELETE: the account row is never removed from the DB.
// An admin can restore it via POST /api/accounts/[id]/restore.
const CONSEQUENCES = [
  "You will be signed out immediately and cannot sign back in.",
  "Your attendance records, event history, and audit trail are preserved for institutional compliance.",
  "You will stop receiving notifications and cannot participate in future events.",
  "Any events you own as an organizer will remain visible to admins but you will lose management access.",
  "Recovery is possible ONLY by contacting an administrator to restore your account.",
];

export function DeactivateAccountDialog({
  open,
  onOpenChange,
  email,
}: DeactivateAccountDialogProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("");
  const deactivate = useDeactivateAccount();

  const expected = "DEACTIVATE";
  const canConfirm =
    typed.toUpperCase() === expected && password.length > 0 && !deactivate.isPending;

  function reset() {
    setStep(1);
    setTyped("");
    setPassword("");
    setReason("");
  }

  function handleClose(o: boolean) {
    if (!o) reset();
    onOpenChange(o);
  }

  async function handleFinalConfirm() {
    if (!canConfirm) return;
    deactivate.mutate(
      { currentPassword: password, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          toast({
            title: "Account deactivated",
            description: "Your account has been deactivated. You will be signed out.",
          });
          handleClose(false);
          // Redirect to the root (login screen) after a brief delay.
          setTimeout(() => {
            window.location.href = "/";
          }, 1500);
        },
        onError: (err: unknown) => {
          const msg =
            err instanceof Error
              ? err.message
              : "Unable to deactivate account. Please try again.";
          toast({
            title: "Deactivation failed",
            description: msg,
            variant: "destructive",
          });
        },
      },
    );
  }

  return (
    <>
      {/* Step 1: Initial warning */}
      <AlertDialog open={open && step === 1} onOpenChange={handleClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-destructive" />
              Deactivate your account?
            </AlertDialogTitle>
            <AlertDialogDescription>
              You are about to deactivate the account for{" "}
              <strong className="text-foreground break-all">{email}</strong>.
              This is a serious action that will restrict your access to Nexus
              Gate. You will have one more chance to review the consequences
              before anything happens.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                setStep(2);
              }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Step 2: Final warning with consequences + password + type-to-confirm */}
      <AlertDialog open={open && step === 2} onOpenChange={handleClose}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Final warning: read carefully
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-left">
                <p className="font-medium text-foreground">
                  If you proceed, the following will happen immediately:
                </p>
                <ul className="space-y-1.5">
                  {CONSEQUENCES.map((c, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <span className="text-destructive mt-0.5 shrink-0">
                        &bull;
                      </span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-sm font-medium text-foreground pt-2">
                  To confirm, enter your password and type{" "}
                  <code className="font-mono bg-muted px-1.5 py-0.5 rounded text-xs">
                    {expected}
                  </code>{" "}
                  below.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="deactivate-password" className="text-sm">
                Your password
              </Label>
              <Input
                id="deactivate-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your current password"
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="deactivate-type" className="text-sm">
                Type {expected} to confirm
              </Label>
              <Input
                id="deactivate-type"
                type="text"
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={expected}
                className="font-mono h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="deactivate-reason" className="text-sm">
                Reason (optional)
              </Label>
              <Textarea
                id="deactivate-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Tell us why you're leaving (helps us improve)…"
                className="min-h-[60px] text-sm"
                maxLength={500}
              />
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleFinalConfirm();
              }}
              disabled={!canConfirm}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deactivate.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Deactivating…
                </>
              ) : (
                <>
                  <UserX className="h-4 w-4" />
                  Permanently deactivate
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
