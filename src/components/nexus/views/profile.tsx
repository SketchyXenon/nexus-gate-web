"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  User,
  Mail,
  Lock,
  Clock,
  Save,
  Loader2,
  KeyRound,
  Shield,
  GraduationCap,
  Calendar,
  Eye,
  EyeOff,
  AlertCircle,
  Info,
  Fingerprint,
  Smartphone,
  Trash2,
  CheckCircle2,
  XCircle,
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
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useProfile,
  useUpdateProfile,
  useChangePassword,
  useDeviceKeys,
  useRevokeDeviceKey,
} from "@/lib/api-client";
import { ROLE_LABELS } from "@/lib/rbac";
import { DiceBearAvatar } from "@/components/nexus/dicebear-avatar";
import { NotificationPreferences } from "@/components/nexus/notification-preferences";
import { PasswordStrengthMeter } from "@/components/nexus/password-meter";
import { toast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { PROGRAMS } from "@/lib/programs";
import { scorePassword } from "@/lib/password-strength";
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

// Sentinel value used by the program Select for the "— Not specified —" option.
// Radix Select doesn't accept empty-string values, so we use a sentinel and
// translate it back to null/empty before submitting.
const NO_PROGRAM = "__none__";

export function ProfileView() {
  const { data: profile, isLoading } = useProfile();
  const updateProfile = useUpdateProfile();
  const changePassword = useChangePassword();

  const [fullName, setFullName] = useState("");
  const [program, setProgram] = useState<string>(NO_PROGRAM);
  const [year, setYear] = useState("1");
  const [section, setSection] = useState("");
  const [loaded, setLoaded] = useState(false);

  // Password dialog
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmNewPassword, setShowConfirmNewPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Save confirmation
  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false);

  // Passkey registration
  const [passkeyLoading, setPasskeyLoading] = useState(false);

  async function handleRegisterPasskey() {
    setPasskeyLoading(true);
    try {
      const res = await fetch("/api/auth/passkey/register-options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Failed to start passkey registration");
      const options = await res.json();

      const { startRegistration } = await import("@simplewebauthn/browser");
      const registration = await startRegistration({ optionsJSON: options });

      const verifyRes = await fetch("/api/auth/passkey/register-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: registration }),
      });
      if (!verifyRes.ok) {
        const data = await verifyRes.json().catch(() => ({}));
        throw new Error(data.error || "Verification failed");
      }
      toast({
        title: "Passkey registered",
        description: "You can now sign in with your passkey.",
      });
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Passkey registration failed";
      if (
        !msg.toLowerCase().includes("cancel") &&
        !msg.toLowerCase().includes("abort")
      ) {
        toast({
          title: "Passkey registration failed",
          description: msg,
          variant: "destructive",
        });
      }
    } finally {
      setPasskeyLoading(false);
    }
  }

  // Load profile data once (useEffect, not render-time setState)
  useEffect(() => {
    if (profile && !loaded) {
      setFullName(profile.fullName);
      setProgram(profile.program ?? NO_PROGRAM);
      setYear(String(profile.year ?? 1));
      setSection(profile.section ?? "");
      setLoaded(true);
    }
  }, [profile, loaded]);

  function handleSaveClick() {
    if (!fullName.trim()) {
      setErrors({ fullName: "Name is required" });
      return;
    }
    setSaveConfirmOpen(true);
  }

  function handleConfirmSave() {
    if (!profile) return;
    setSaveConfirmOpen(false);

    // Translate the "— Not specified —" sentinel back to empty/null for the API.
    const programValue = program === NO_PROGRAM ? "" : program;

    const vars: {
      fullName: string;
      program?: string;
      year?: number;
      section?: string;
    } = {
      fullName: fullName.trim(),
    };

    if (profile.role === "USER") {
      if (year) vars.year = Number(year);
      if (section.trim()) vars.section = section.trim();
      // Only send program if it changed and the user can still change it
      // (course can only be changed once).
      if (programValue !== (profile.program ?? "") && profile.canChangeCourse) {
        vars.program = programValue;
      }
    }

    updateProfile.mutate(vars, {
      onSuccess: () => {
        toast({
          title: "Profile updated",
          description: "Your changes have been saved.",
        });
      },
      onError: (err) =>
        toast({
          title: "Update failed",
          description: err.message,
          variant: "destructive",
        }),
    });
  }

  function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmNewPassword) {
      setErrors({ confirmNewPassword: "Passwords don't match" });
      return;
    }
    changePassword.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: (data) => {
          toast({ title: "Password changed", description: data.message });
          setPasswordDialogOpen(false);
          setCurrentPassword("");
          setNewPassword("");
          setConfirmNewPassword("");
          setErrors({});
        },
        onError: (err) =>
          toast({
            title: "Failed",
            description: err.message,
            variant: "destructive",
          }),
      },
    );
  }

  if (isLoading || !profile) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const isAdmin = profile.role === "ADMIN";
  const isUser = profile.role === "USER";
  const isOrganizer = profile.role === "ORGANIZER";

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header card with gradient accent */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="relative overflow-hidden border-primary/20">
          <div className="absolute -top-16 -right-16 h-48 w-48 rounded-full bg-primary/10 blur-3xl pointer-events-none" />
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-primary/60 to-transparent" />
          <CardContent className="relative p-6">
            <div className="flex items-center gap-4">
              <div className="relative">
                <DiceBearAvatar fullName={profile.fullName} size={72} />
                <div className="absolute -bottom-1 -right-1 grid place-items-center h-6 w-6 rounded-full bg-background border-2 border-background">
                  <div className={`h-3 w-3 rounded-full ${profile.status === "ACTIVE" ? "bg-emerald-500" : profile.status === "SUSPENDED" ? "bg-red-500" : "bg-amber-500"}`} />
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="font-heading text-xl font-bold truncate">
                  {profile.fullName}
                </h2>
                <p className="text-sm text-muted-foreground truncate flex items-center gap-1">
                  <Mail className="h-3 w-3 shrink-0" />
                  {profile.email}
                </p>
                <div className="flex gap-2 mt-2 flex-wrap">
                  <Badge variant="secondary" className="gap-1">
                    <Shield className="h-3 w-3" />
                    {ROLE_LABELS[profile.role]}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={
                      profile.status === "ACTIVE"
                        ? "border-emerald-500/40 text-emerald-600"
                        : profile.status === "SUSPENDED"
                          ? "border-red-500/40 text-red-600"
                          : "border-amber-500/40 text-amber-600"
                    }
                  >
                    {profile.status}
                  </Badge>
                  {profile.lastLoginAt && (
                    <Badge variant="outline" className="text-muted-foreground gap-1">
                      <Clock className="h-3 w-3" />
                      Last login: {new Date(profile.lastLoginAt).toLocaleDateString()}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Account info (read-only) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4 text-primary" /> Account info
          </CardTitle>
          <CardDescription>
            These details are managed by your administrator.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {profile.studentId && (
            <InfoRow
              icon={<GraduationCap className="h-4 w-4" />}
              label="Student ID"
              value={String(profile.studentId)}
            />
          )}
          {profile.program && (
            <InfoRow
              icon={<User className="h-4 w-4" />}
              label="Program"
              value={profile.program}
            />
          )}
          {profile.section && (
            <InfoRow
              icon={<User className="h-4 w-4" />}
              label="Section"
              value={profile.section}
            />
          )}
          {profile.year && (
            <InfoRow
              icon={<GraduationCap className="h-4 w-4" />}
              label="Year"
              value={`Year ${profile.year}`}
            />
          )}
          <InfoRow
            icon={<Calendar className="h-4 w-4" />}
            label="Member since"
            value={format(
              new Date(profile.createdAt || Date.now()),
              "MMMM d, yyyy",
            )}
          />
          {profile.lastLoginAt && (
            <InfoRow
              icon={<Clock className="h-4 w-4" />}
              label="Last sign-in"
              value={format(
                new Date(profile.lastLoginAt),
                "MMM d, yyyy 'at' HH:mm",
              )}
            />
          )}
        </CardContent>
      </Card>

      {/* Edit profile — excluded for admins */}
      {!isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <User className="h-4 w-4 text-primary" /> Edit profile
            </CardTitle>
            <CardDescription className="flex items-center gap-1.5">
              {profile.canUpdateProfile
                ? "Edit your profile"
                : `Next update in ${profile.daysUntilProfileUpdate} day${profile.daysUntilProfileUpdate === 1 ? "" : "s"}.`}
              {isUser && profile.canUpdateProfile && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    Profile updates are limited to once every 30 days. Course
                    can only be changed once.
                  </TooltipContent>
                </Tooltip>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Full name — both users and organizers (numbers stripped, like registration) */}
              <div className="space-y-1.5">
                <Label htmlFor="fullName">Full name</Label>
                <Input
                  id="fullName"
                  value={fullName}
                  onChange={(e) =>
                    setFullName(e.target.value.replace(/[0-9]/g, ""))
                  }
                  disabled={
                    !profile.canUpdateProfile || updateProfile.isPending
                  }
                />
                {errors.fullName && (
                  <p className="text-xs text-destructive">{errors.fullName}</p>
                )}
              </div>

              {/* Student-only fields */}
              {isUser && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Program (course) — dropdown, can only change once */}
                    <div className="space-y-1.5">
                      <Label
                        htmlFor="program"
                        className="flex items-center gap-1.5"
                      >
                        Program (course)
                        {!profile.canChangeCourse && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Lock className="h-3 w-3 text-amber-600 cursor-help" />
                            </TooltipTrigger>
                            <TooltipContent>
                              Locked — course can only be changed once. Contact
                              an admin to reset.
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </Label>
                      <Select
                        value={program}
                        onValueChange={setProgram}
                        disabled={
                          !profile.canUpdateProfile ||
                          !profile.canChangeCourse ||
                          updateProfile.isPending
                        }
                      >
                        <SelectTrigger id="program" className="w-full">
                          <SelectValue placeholder="Select a program" />
                        </SelectTrigger>
                        <SelectContent className="max-w-[calc(100vw-1.5rem)]">
                          <SelectItem value={NO_PROGRAM}>
                            — Not specified —
                          </SelectItem>
                          {PROGRAMS.map((p) => (
                            <SelectItem key={p.code} value={p.code}>
                              {p.code} — {p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Year level */}
                    <div className="space-y-1.5">
                      <Label htmlFor="year">Year level</Label>
                      <Select
                        value={year}
                        onValueChange={setYear}
                        disabled={
                          !profile.canUpdateProfile || updateProfile.isPending
                        }
                      >
                        <SelectTrigger id="year">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="1">Year 1</SelectItem>
                          <SelectItem value="2">Year 2</SelectItem>
                          <SelectItem value="3">Year 3</SelectItem>
                          <SelectItem value="4">Year 4</SelectItem>
                          <SelectItem value="5">Year 5</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Section */}
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="section"
                      className="flex items-center gap-1.5"
                    >
                      Section
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent>
                          Format: year-letter (e.g. "2-A", "3-B"). Must match
                          your year level.
                        </TooltipContent>
                      </Tooltip>
                    </Label>
                    <Input
                      id="section"
                      placeholder={`${year || "1"}-A`}
                      value={section}
                      onChange={(e) => setSection(e.target.value)}
                      disabled={
                        !profile.canUpdateProfile || updateProfile.isPending
                      }
                    />
                  </div>
                </>
              )}

              {/* Organizer note */}
              {isOrganizer && (
                <p className="text-[11px] text-muted-foreground">
                  Edit your name above. Contact admin for role changes.
                </p>
              )}

              <Button
                type="button"
                className="w-full"
                disabled={!profile.canUpdateProfile || updateProfile.isPending}
                onClick={handleSaveClick}
              >
                {updateProfile.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {profile.canUpdateProfile
                  ? "Save profile"
                  : `Locked for ${profile.daysUntilProfileUpdate} more days`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Change password — all roles, with 30-day cooldown */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="h-4 w-4 text-primary" /> Password
          </CardTitle>
          <CardDescription className="flex items-center gap-1.5">
            {profile.canChangePassword
              ? "Change your password anytime. You'll be signed out on other devices."
              : `You can change your password again in ${profile.daysUntilPasswordChange} day${profile.daysUntilPasswordChange === 1 ? "" : "s"}.`}
            {!profile.canChangePassword && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  Password changes are limited to once every 30 days for
                  security.
                </TooltipContent>
              </Tooltip>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => setPasswordDialogOpen(true)}
            disabled={!profile.canChangePassword}
          >
            <KeyRound className="h-4 w-4" />
            {profile.canChangePassword
              ? "Change password"
              : `Locked for ${profile.daysUntilPasswordChange} more days`}
          </Button>
        </CardContent>
      </Card>

      {/* Passkey (WebAuthn) — register a biometric/security-key credential */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Fingerprint className="h-4 w-4 text-primary" /> Passkey
          </CardTitle>
          <CardDescription>
            Sign in instantly with your fingerprint, face, or security key. No
            password needed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            className="w-full"
            disabled={passkeyLoading}
            onClick={handleRegisterPasskey}
          >
            {passkeyLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Fingerprint className="h-4 w-4" />
            )}
            Register passkey
          </Button>
        </CardContent>
      </Card>

      {/* Registered Devices — self-service device key management */}
      <RegisteredDevicesCard />

      {/* Notification preferences */}
      <NotificationPreferences />

      {/* Save confirmation dialog */}
      <AlertDialog open={saveConfirmOpen} onOpenChange={setSaveConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save profile changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You can only update your profile once every 30 days. Please review
              your changes carefully before saving.
              {isUser &&
                profile.canChangeCourse &&
                (program === NO_PROGRAM ? "" : program) !==
                  (profile.program ?? "") && (
                  <span className="block mt-2 text-amber-600 font-medium">
                    Warning: You are changing your course from "
                    {profile.program || "— Not specified —"}" to "
                    {program === NO_PROGRAM ? "— Not specified —" : program}".
                    This can only be done once.
                  </span>
                )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmSave}>
              Yes, save changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Change password dialog */}
      <Dialog open={passwordDialogOpen} onOpenChange={setPasswordDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription className="flex items-center gap-1.5">
              Enter your current and new password.
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  You'll be signed out on other devices. Password changes are
                  limited to once every 30 days.
                </TooltipContent>
              </Tooltip>
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleChangePassword} className="space-y-3">
            {/* Current password — WITH eye toggle */}
            <div className="space-y-1.5">
              <Label htmlFor="currentPassword">Current password</Label>
              <div className="relative">
                <Input
                  id="currentPassword"
                  type={showCurrentPassword ? "text" : "password"}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showCurrentPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
            {/* New password — WITH eye toggle + strength meter */}
            <div className="space-y-1.5">
              <Label
                htmlFor="newPassword"
                className="flex items-center gap-1.5"
              >
                New password
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    Must be "Good" or "Strong" — 8+ chars with uppercase,
                    lowercase, a number, and a special character (or 12+ chars).
                  </TooltipContent>
                </Tooltip>
              </Label>
              <div className="relative">
                <Input
                  id="newPassword"
                  type={showNewPassword ? "text" : "password"}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  className="pr-10"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPassword(!showNewPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showNewPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              <PasswordStrengthMeter password={newPassword} />
            </div>
            {/* Confirm password — match indicator (no eye toggle) */}
            <div className="space-y-1.5">
              <Label htmlFor="confirmNewPassword">Confirm new password</Label>
              <div className="relative">
                <Input
                  id="confirmNewPassword"
                  type="password"
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                  className={`pr-10 ${
                    confirmNewPassword && confirmNewPassword === newPassword
                      ? "border-emerald-500/50 focus-visible:ring-emerald-500/50"
                      : confirmNewPassword && confirmNewPassword !== newPassword
                        ? "border-destructive/50 focus-visible:ring-destructive/50"
                        : ""
                  }`}
                />
                {confirmNewPassword && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2">
                    {confirmNewPassword === newPassword ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <XCircle className="h-4 w-4 text-destructive/60" />
                    )}
                  </span>
                )}
              </div>
              {errors.confirmNewPassword ? (
                <p className="text-xs text-destructive">
                  {errors.confirmNewPassword}
                </p>
              ) : confirmNewPassword && confirmNewPassword === newPassword ? (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">
                  Passwords match
                </p>
              ) : null}
            </div>
            <div className="flex gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => setPasswordDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="flex-1"
                disabled={
                  changePassword.isPending ||
                  (newPassword.length > 0 && !scorePassword(newPassword).passes)
                }
              >
                {changePassword.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Update password
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="text-muted-foreground shrink-0">{icon}</div>
      <span className="text-muted-foreground w-32 shrink-0">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

// ---- Registered Devices card (self-service device key management) ----
function RegisteredDevicesCard() {
  const { data, isLoading } = useDeviceKeys();
  const revoke = useRevokeDeviceKey();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const deviceKeys = data?.deviceKeys ?? [];
  const activeKeys = deviceKeys.filter((k) => !k.revokedAt);

  function handleRevoke(keyId: string) {
    revoke.mutate(keyId, {
      onSuccess: () => {
        toast({ title: "Device revoked" });
        setConfirmId(null);
      },
      onError: (err) => {
        toast({
          title: "Couldn't revoke device",
          description: err.message,
          variant: "destructive",
        });
        setConfirmId(null);
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Smartphone className="h-4 w-4 text-primary" /> Registered devices
        </CardTitle>
        <CardDescription>
          Devices that can sign scan certificates. Max 5 active. Revoke old
          devices to free up slots.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading devices…
          </div>
        ) : activeKeys.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No active devices. Your device key is registered automatically when
            you scan your first QR code.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
              <span>{activeKeys.length} active of 5 max</span>
            </div>
            <div className="divide-y rounded-lg border">
              {activeKeys.map((key) => (
                <div
                  key={key.id}
                  className="px-3 py-2.5 flex items-center gap-3"
                >
                  <div className="grid place-items-center h-8 w-8 rounded-lg bg-primary/10 text-primary shrink-0">
                    <Smartphone className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {key.label || "Unnamed device"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Added {format(new Date(key.createdAt), "MMM d, yyyy")}
                      {key.lastUsedAt
                        ? ` · Last used ${format(new Date(key.lastUsedAt), "MMM d")}`
                        : " · Never used"}
                    </p>
                  </div>
                  {confirmId === key.id ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 text-xs"
                        disabled={revoke.isPending}
                        onClick={() => handleRevoke(key.id)}
                      >
                        {revoke.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          "Confirm"
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => setConfirmId(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => setConfirmId(key.id)}
                      aria-label="Revoke device"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
