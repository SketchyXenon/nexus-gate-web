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
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  HelpCircle,
} from "lucide-react";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** If true, shows red warning styling. Defaults to false. */
  destructive?: boolean;
  /** The word the user must type to confirm (case-insensitive). Defaults to "DELETE". */
  confirmText?: string;
  /** Override the step-2 warning text. Defaults to "This action cannot be undone." */
  step2Warning?: string;
  onConfirm: () => Promise<void> | void;
}

// Reusable double-confirmation dialog.
// - destructive=true → red warning (for deletions, suspensions, cancellations)
// - destructive=false → neutral/positive (for additions, activations, manual entries)
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  confirmText = "DELETE",
  step2Warning,
  onConfirm,
}: ConfirmDialogProps) {
  const expected = confirmText.toUpperCase();
  const [typed, setTyped] = useState("");
  const [step, setStep] = useState<1 | 2>(1);
  const [loading, setLoading] = useState(false);

  function reset() {
    setStep(1);
    setTyped("");
    setLoading(false);
  }

  async function handleConfirm() {
    if (step === 1) {
      setStep(2);
      return;
    }
    setLoading(true);
    try {
      await onConfirm();
      onOpenChange(false);
      reset();
    } catch {
      // Error handling done by caller via toast
    } finally {
      setLoading(false);
    }
  }

  // Icon based on destructive flag
  const Icon = destructive ? AlertTriangle : CheckCircle2;
  const iconColor = destructive ? "text-destructive" : "text-primary";

  // Step 2 warning text
  const warningText =
    step2Warning ??
    (destructive
      ? "This action cannot be undone."
      : "Please confirm this action.");

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Icon className={`h-5 w-5 ${iconColor}`} />
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {step === 1 ? (
              description
            ) : (
              <>
                <strong className="text-foreground">
                  {warningText}
                </strong>{" "}
                Type{" "}
                <code className="font-mono bg-muted px-1.5 py-0.5 rounded text-xs">
                  {expected}
                </code>{" "}
                to confirm.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {step === 2 && (
          <input
            autoFocus
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={`Type ${expected}`}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
          />
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              if (step === 2 && typed.toUpperCase() !== expected) return;
              handleConfirm();
            }}
            disabled={(step === 2 && typed.toUpperCase() !== expected) || loading}
            className={
              destructive
                ? "bg-destructive text-white hover:bg-destructive/90"
                : ""
            }
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : step === 1 ? (
              "Continue"
            ) : (
              confirmLabel
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
