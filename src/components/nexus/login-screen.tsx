"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ShieldCheck,
  LogIn,
  UserPlus,
  ArrowLeft,
  ArrowRight,
  Loader2,
  Mail,
  MailCheck,
  CheckCircle2,
  XCircle,
  Hash,
  HelpCircle,
  FileText,
  Lock,
  Eye,
  EyeOff,
  Info,
  Fingerprint,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
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
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ThemeToggle } from "./theme-toggle";
import { CookieConsent } from "./cookie-consent";
import { InfoModals, openInfoModal } from "./info-modals";
import { LandingPage } from "./landing-page";
import { PasswordStrengthMeter } from "./password-meter";
import { NexusLogo } from "./nexus-logo";

import { PROGRAMS } from "@/lib/programs";
import {
  useLogin,
  useRegister,
  useForgotPassword,
  useResetPassword,
  useCheckAvailability,
} from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { ROLE_LABELS, ROLE_DESCRIPTIONS, type Role } from "@/lib/rbac";

type Mode =
  | "landing"
  | "login"
  | "register"
  | "success"
  | "forgot"
  | "forgot-success"
  | "reset"
  | "reset-success";

// sessionStorage key for the in-flight password-reset token.
// We persist the token here so a refresh mid-flow doesn't lose it,
// and so we can scrub it from the URL after detecting ?reset=… .
const RESET_TOKEN_KEY = "ng_reset_token";
// sessionStorage flag set when a recovery (password reset) session is active.
// Ensures the reset form stays visible even if useMe() succeeds and page.tsx
// would otherwise render AppShell. Cleared when the user completes the reset.
const RECOVERY_PENDING_KEY = "ng_recovery_pending";
// Sentinel value used by the program Select for the "— Not specified —" option.
// Radix Select doesn't accept empty-string values, so we use a sentinel and
// translate it back to null/empty before submitting.
const NO_PROGRAM = "__none__";

// Demo accounts removed — use bootstrap-admin.ts to create the first admin.

export function LoginScreen({
  initialMode = "landing",
}: {
  initialMode?: Mode;
}) {
  // ---- Detect ?reset=TOKEN on mount (lazy useState initializer, NOT useEffect) ----
  // We read the token from the URL once on first render. If present, we stash
  // it in sessionStorage (so a refresh doesn't drop it) and rewrite the URL to
  // strip the token (so it doesn't leak into browser history or referrers).
  // On subsequent loads with no ?reset= in the URL, we fall back to whatever
  // token may still be living in sessionStorage.
  const [resetToken, setResetToken] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("reset");
    if (fromUrl) {
      sessionStorage.setItem(RESET_TOKEN_KEY, fromUrl);
      // Clean the URL — keep the path, drop the query string.
      window.history.replaceState({}, "", window.location.pathname);
      return fromUrl;
    }
    return sessionStorage.getItem(RESET_TOKEN_KEY);
  });

  // If we recovered a token OR the recovery-pending flag is set, jump
  // straight into the reset flow on mount.
  const recoveryPending =
    typeof window !== "undefined" &&
    sessionStorage.getItem(RECOVERY_PENDING_KEY) === "1";
  const [mode, setMode] = useState<Mode>(
    resetToken || recoveryPending ? "reset" : initialMode,
  );

  // Handle Supabase email redirects (?code=... or hash-based tokens).
  // recovery: password reset - show the new-password form.
  // magiclink/signup: passwordless sign-in or verification - reload once
  // the Supabase session is established.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const params = url.searchParams;
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
    const code = params.get("code");
    const type = params.get("type") || hashParams.get("type");
    const accessToken = hashParams.get("access_token");
    const refreshToken = hashParams.get("refresh_token");
    if (!code && !accessToken) return;

    const finalizeAuth = async (resolvedType?: string) => {
      window.history.replaceState({}, "", window.location.pathname);
      // Use the resolved type from the callback response (AMR-based) if
      // available; fall back to the URL type param.
      const effectiveType = resolvedType || type;
      if (effectiveType === "recovery") {
        // Set the recovery-pending flag so page.tsx renders LoginScreen
        // (not AppShell) even if useMe() succeeds with the recovery session.
        sessionStorage.setItem(RECOVERY_PENDING_KEY, "1");
        setResetToken("supabase-recovery");
        setMode("reset");
      } else {
        // magiclink or signup - session established, reload to dashboard.
        window.location.reload();
      }
    };

    // PKCE flow (?code=...): exchange via the SERVER API route.
    // The code_verifier is stored in an httpOnly cookie set during
    // signInWithOtp/resetPasswordForEmail (server-side). The browser
    // client can't read httpOnly cookies, so we must exchange server-side.
    // The callback returns the resolved type (recovery vs magiclink) from
    // the session's AMR claim — more reliable than the URL type param.
    const codeExchangePromise = code
      ? fetch(
          `/api/auth/callback?code=${encodeURIComponent(code)}${type ? `&type=${encodeURIComponent(type)}` : ""}`,
          { credentials: "include" },
        ).then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || "Code exchange failed");
          }
          return res.json() as Promise<{ ok: boolean; type: string }>;
        })
      : accessToken && refreshToken
        ? import("@/lib/supabase-browser").then(
            ({ createSupabaseBrowserClient }) =>
              createSupabaseBrowserClient().auth.setSession({
                access_token: accessToken,
                refresh_token: refreshToken,
              }),
          )
        : Promise.reject(new Error("Missing auth tokens in redirect URL"));

    codeExchangePromise
      .then(async (result) => {
        await finalizeAuth(result?.type);
      })
      .catch((e) => {
        // Code exchange failed (expired, already used, cross-device PKCE mismatch).
        // Clean the URL and show a toast so the user isn't stuck on a blank page.
        console.error("[auth] email redirect handling failed:", e);
        window.history.replaceState({}, "", window.location.pathname);
        toast({
          title: "Link expired",
          description:
            "The sign-in link is invalid or expired. Please request a new one.",
          variant: "destructive",
        });
      });
  }, []);

  function clearResetToken() {
    if (typeof window !== "undefined") {
      sessionStorage.removeItem(RESET_TOKEN_KEY);
    }
    setResetToken(null);
  }

  if (mode === "landing") {
    return (
      <LandingPage
        onSignIn={() => setMode("login")}
        onRegister={() => setMode("register")}
      />
    );
  }

  return (
    <AuthScreen
      mode={mode}
      setMode={setMode}
      resetToken={resetToken}
      onResetConsumed={clearResetToken}
    />
  );
}

interface AuthScreenProps {
  mode: Mode;
  setMode: (m: Mode) => void;
  resetToken: string | null;
  onResetConsumed: () => void;
}

function AuthScreen({
  mode,
  setMode,
  resetToken,
  onResetConsumed,
}: AuthScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [studentId, setStudentId] = useState("");
  const [program, setProgram] = useState<string>(NO_PROGRAM);
  const [section, setSection] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showPassword, setShowPassword] = useState(false);
  const [showRegPassword, setShowRegPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmNewPassword, setShowConfirmNewPassword] = useState(false);
  // Multi-step registration wizard: 1=Account, 2=Identity, 3=Program.
  const [regStep, setRegStep] = useState(1);
  // New-password fields for the reset flow.
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  // Remembers the email used in the forgot-password form so we can echo it
  // back on the "Check your email" success screen.
  const [forgotEmail, setForgotEmail] = useState("");
  // Remembers the email used at registration so the success screen can
  // show "Account created for <email>" even if the user edited the field.
  const [registeredEmail, setRegisteredEmail] = useState("");
  // Whether the registration requires email confirmation (Supabase sends a link).
  const [needsEmailConfirmation, setNeedsEmailConfirmation] = useState(false);

  const login = useLogin();
  const register = useRegister();
  const forgotPassword = useForgotPassword();
  const resetPassword = useResetPassword();

  // Reset the registration wizard when leaving register mode.
  useEffect(() => {
    if (mode !== "register") setRegStep(1);
  }, [mode]);

  // ---- Debounced availability check for registration ----
  // Only check when email/studentId are format-valid. 400ms debounce.
  const [debouncedEmail, setDebouncedEmail] = useState<string | null>(null);
  const [debouncedStudentId, setDebouncedStudentId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    const t = setTimeout(() => {
      const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      setDebouncedEmail(
        mode === "register" && emailValid ? email.toLowerCase() : null,
      );
      const sidValid = /^\d{7}$/.test(studentId.trim());
      setDebouncedStudentId(
        mode === "register" && sidValid ? studentId.trim() : null,
      );
    }, 400);
    return () => clearTimeout(t);
  }, [email, studentId, mode]);

  const availability = useCheckAvailability(debouncedEmail, debouncedStudentId);
  const emailTaken =
    availability.data?.emailTaken === true && !availability.isError;
  const studentIdTaken =
    availability.data?.studentIdTaken === true && !availability.isError;
  const emailChecking = !!debouncedEmail && availability.isLoading;
  const studentIdChecking = !!debouncedStudentId && availability.isLoading;
  // When the check fails (rate limited or network error), don't claim available.
  const emailCheckFailed =
    !!debouncedEmail && !availability.isLoading && availability.isError;
  const studentIdCheckFailed =
    !!debouncedStudentId && !availability.isLoading && availability.isError;

  // Clear stale "Checking..." errors when the availability check completes.
  // Without this, validateRegStep's "Checking..." message stays even after
  // the check resolves (the inline indicator updates, but the error text doesn't).
  useEffect(() => {
    if (!availability.isLoading && availability.data) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next.email;
        delete next.studentId;
        return next;
      });
    }
  }, [availability.data, availability.isLoading]);

  // ---- Magic link (passwordless email login) ----
  const [magicLinkSending, setMagicLinkSending] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);

  async function handleMagicLink() {
    if (!email) {
      setErrors({ email: "Enter your email first" });
      return;
    }
    setMagicLinkSending(true);
    try {
      const res = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setMagicLinkSent(true);
        toast({
          title: "Magic link sent",
          description: "Check your email for a sign-in link.",
        });
      } else {
        const data = await res.json().catch(() => ({}));
        toast({
          title: "Couldn't send magic link",
          description: data.error || "Try again.",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Couldn't send magic link",
        description: "Network error.",
        variant: "destructive",
      });
    } finally {
      setMagicLinkSending(false);
    }
  }

  // ---- Passkey (WebAuthn) sign-in ----
  const [passkeyLoading, setPasskeyLoading] = useState(false);

  async function handlePasskeySignIn() {
    setPasskeyLoading(true);
    try {
      const res = await fetch("/api/auth/passkey/login-options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Failed to get passkey options");
      const options = await res.json();

      const { startAuthentication } = await import("@simplewebauthn/browser");
      const assertion = await startAuthentication({ optionsJSON: options });

      const verifyRes = await fetch("/api/auth/passkey/login-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion }),
      });
      if (!verifyRes.ok) {
        const data = await verifyRes.json().catch(() => ({}));
        throw new Error(data.error || "Passkey verification failed");
      }
      // Session cookie was set server-side by the login-verify route.
      // No need to call setSession() client-side (tokens are httpOnly).
      toast({ title: "Signed in with passkey!" });
      window.location.reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Passkey sign-in failed";
      if (
        !msg.toLowerCase().includes("cancel") &&
        !msg.toLowerCase().includes("abort")
      ) {
        toast({
          title: "Passkey sign-in failed",
          description: msg,
          variant: "destructive",
        });
      }
    } finally {
      setPasskeyLoading(false);
    }
  }

  function validateLogin() {
    const e: Record<string, string> = {};
    if (!email) e.email = "Enter your email";
    if (!password) e.password = "Enter your password";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  // Validate one step of the registration wizard.
  function validateRegStep(step: number) {
    const e: Record<string, string> = {};
    if (step === 1) {
      if (!email) {
        e.email = "Enter your email";
      } else {
        // Check if the availability check has fired for the CURRENT email.
        // If the user typed fast and clicked Continue before the 400ms
        // debounce, debouncedEmail may be stale — force it now and block.
        const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        if (emailValid) {
          const normalizedEmail = email.toLowerCase();
          if (debouncedEmail !== normalizedEmail) {
            // Force the debounce immediately so the check fires now.
            setDebouncedEmail(normalizedEmail);
            e.email = "Checking email availability…";
          } else if (emailTaken) {
            e.email = "This email is already registered";
          } else if (emailChecking) {
            e.email = "Checking email availability…";
          }
        } else {
          e.email = "Enter a valid email address";
        }
      }
      if (password.length < 8) {
        e.password = "At least 8 characters";
      } else if (!/[A-Z]/.test(password)) {
        e.password = "Include an uppercase letter";
      } else if (!/[a-z]/.test(password)) {
        e.password = "Include a lowercase letter";
      } else if (!/[0-9]/.test(password)) {
        e.password = "Include a number";
      } else if (!/[^A-Za-z0-9]/.test(password)) {
        e.password = "Include a special character (!@#$...)";
      }
      if (password !== confirmPassword)
        e.confirmPassword = "Passwords don't match";
    } else if (step === 2) {
      if (!fullName.trim()) e.fullName = "Enter your full name";
      if (!/^\d{7}$/.test(studentId.trim())) {
        e.studentId = "Must be 7 digits";
      } else {
        const normalizedSid = studentId.trim();
        if (debouncedStudentId !== normalizedSid) {
          // Force the debounce immediately so the check fires now.
          setDebouncedStudentId(normalizedSid);
          e.studentId = "Checking student ID availability…";
        } else if (studentIdTaken) {
          e.studentId = "This student ID is already registered";
        } else if (studentIdChecking) {
          e.studentId = "Checking student ID availability…";
        }
      }
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function validateReset() {
    const e: Record<string, string> = {};
    // Password: match backend strongPasswordSchema rules.
    if (newPassword.length < 8) {
      e.newPassword = "At least 8 characters";
    } else if (!/[A-Z]/.test(newPassword)) {
      e.newPassword = "Include an uppercase letter";
    } else if (!/[a-z]/.test(newPassword)) {
      e.newPassword = "Include a lowercase letter";
    } else if (!/[0-9]/.test(newPassword)) {
      e.newPassword = "Include a number";
    } else if (!/[^A-Za-z0-9]/.test(newPassword)) {
      e.newPassword = "Include a special character (!@#$...)";
    }
    if (newPassword !== confirmNewPassword)
      e.confirmNewPassword = "Passwords don't match";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!validateLogin()) return;
    login.mutate(
      { email, password },
      {
        onSuccess: () =>
          toast({
            title: "Welcome back!",
            description: "Loading your dashboard...",
          }),
        onError: (err) => {
          toast({
            title: "Couldn't sign in",
            description: err.message,
            variant: "destructive",
          });
        },
      },
    );
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    // Guard: if the user pressed Enter on step 1 or 2, advance instead of submit.
    if (regStep === 1) {
      if (validateRegStep(1)) {
        setErrors({});
        setRegStep(2);
      }
      return;
    }
    if (regStep === 2) {
      if (validateRegStep(2)) {
        setErrors({});
        setRegStep(3);
      }
      return;
    }
    // Step 3: program/section are optional, so just submit.
    // Translate the "— Not specified —" sentinel back to empty/null for the API.
    const programValue = program === NO_PROGRAM ? "" : program;
    register.mutate(
      {
        email,
        password,
        fullName,
        studentId: Number(studentId),
        program: programValue,
        section: section.trim(),
      },
      {
        onSuccess: (data) => {
          setRegisteredEmail(data.email || email);
          setNeedsEmailConfirmation(!!data.needsEmailConfirmation);
          setMode("success");
          toast({
            title: "Account created!",
            description: data.needsEmailConfirmation
              ? "Check your email to confirm your account, then sign in."
              : data.whitelisted
                ? "Your student ID was found on the approved list. Sign in to activate your account."
                : "Sign in to activate your account.",
          });
        },
        onError: (err) => {
          toast({
            title: "Couldn't create account",
            description: err.message,
            variant: "destructive",
          });
        },
      },
    );
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    const e2: Record<string, string> = {};
    if (!email) e2.email = "Enter your email";
    setErrors(e2);
    if (Object.keys(e2).length > 0) return;
    setForgotEmail(email);
    forgotPassword.mutate(
      { email },
      {
        onSuccess: () => {
          setMode("forgot-success");
          toast({
            title: "Reset link sent",
            description: "Check your email inbox.",
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't send reset link",
            description: err.message,
            variant: "destructive",
          }),
      },
    );
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    if (!validateReset()) return;
    if (!resetToken) {
      toast({
        title: "Reset link missing",
        description: "Please request a new password reset link.",
        variant: "destructive",
      });
      return;
    }
    resetPassword.mutate(
      { password: newPassword },
      {
        onSuccess: () => {
          // The token is single-use — clear it so it can't be replayed.
          onResetConsumed();
          // Clear the recovery-pending flag — the user has completed the reset.
          if (typeof window !== "undefined") {
            sessionStorage.removeItem(RECOVERY_PENDING_KEY);
          }
          setNewPassword("");
          setConfirmNewPassword("");
          setMode("reset-success");
          toast({
            title: "Password reset",
            description: "You can now sign in with your new password.",
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't reset password",
            description: err.message,
            variant: "destructive",
          }),
      },
    );
  }

  return (
    <div className="min-h-screen flex flex-col relative overflow-hidden">
      <AuthBackground />

      {/* Top bar */}
      <div className="relative z-10 flex items-center justify-between p-4">
        <button
          onClick={() => setMode("landing")}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => openInfoModal("faq")}
          >
            <HelpCircle className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => openInfoModal("terms")}
          >
            <FileText className="h-4 w-4" />
          </Button>
          <ThemeToggle />
        </div>
      </div>

      {/* Auth form */}
      <main className="relative z-10 flex-1 flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-md">
          {/* Logo */}
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-3 mb-6 justify-center"
          >
            <NexusLogo className="h-10 w-10" />
            <div>
              <p className="font-heading font-semibold">Nexus Gate</p>
              <p className="text-xs text-muted-foreground">Attendance System</p>
            </div>
          </motion.div>

          <AnimatePresence mode="wait">
            <motion.div
              key={mode}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              <Card className="border-border/60 shadow-xl backdrop-blur-sm bg-card/95">
                <CardHeader>
                  <CardTitle className="font-heading text-2xl">
                    {mode === "login" && "Welcome back"}
                    {mode === "register" && "Create account"}
                    {mode === "success" &&
                      (needsEmailConfirmation
                        ? "Check your email"
                        : "Account ready")}
                    {mode === "forgot" && "Forgot password"}
                    {mode === "forgot-success" && "Check your email"}
                    {mode === "reset" && "Reset password"}
                    {mode === "reset-success" && "Password reset"}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {/* LOGIN */}
                  {mode === "login" && (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Button
                          variant="outline"
                          className="w-full h-11 transition-all hover:scale-[1.01]"
                          onClick={handlePasskeySignIn}
                          disabled={passkeyLoading}
                        >
                          {passkeyLoading ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Fingerprint className="h-5 w-5" />
                          )}
                          Sign in with Passkey
                        </Button>
                        <Button
                          variant="outline"
                          className="w-full h-11 transition-all hover:scale-[1.01]"
                          onClick={handleMagicLink}
                          disabled={magicLinkSending || magicLinkSent}
                        >
                          {magicLinkSending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : magicLinkSent ? (
                            <MailCheck className="h-5 w-5" />
                          ) : (
                            <Mail className="h-5 w-5" />
                          )}
                          {magicLinkSent
                            ? "Magic link sent"
                            : "Sign in with email link"}
                        </Button>
                      </div>
                      <div className="relative">
                        <Separator />
                        <span className="absolute left-1/2 -translate-x-1/2 -top-2.5 bg-card px-2 text-[11px] text-muted-foreground">
                          or password
                        </span>
                      </div>
                      <form onSubmit={handleLogin} className="space-y-3">
                        <div className="space-y-1.5">
                          <Label htmlFor="email">Email</Label>
                          <div className="relative">
                            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                              id="email"
                              type="email"
                              autoComplete="email"
                              placeholder="yourname@gmail.com"
                              value={email}
                              onChange={(e) => setEmail(e.target.value)}
                              className="pl-9"
                            />
                          </div>
                          {errors.email && (
                            <p className="text-xs text-destructive">
                              {errors.email}
                            </p>
                          )}
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="password">Password</Label>
                          <div className="relative">
                            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                              id="password"
                              type={showPassword ? "text" : "password"}
                              autoComplete="current-password"
                              placeholder="••••••••"
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              className="pl-9 pr-10"
                            />
                            <button
                              type="button"
                              onClick={() => setShowPassword(!showPassword)}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                            >
                              {showPassword ? (
                                <EyeOff className="h-4 w-4" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
                            </button>
                          </div>
                          {errors.password && (
                            <p className="text-xs text-destructive">
                              {errors.password}
                            </p>
                          )}
                        </div>
                        <Button
                          type="submit"
                          className="w-full h-10 transition-all hover:scale-[1.01]"
                          disabled={login.isPending}
                        >
                          {login.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <LogIn className="h-4 w-4" />
                          )}
                          Sign in
                        </Button>
                      </form>
                      <div className="flex items-center justify-between text-sm">
                        <button
                          type="button"
                          onClick={() => {
                            setMode("forgot");
                            setErrors({});
                          }}
                          className="text-muted-foreground hover:text-primary hover:underline"
                        >
                          Forgot password?
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setMode("register");
                            setErrors({});
                          }}
                          className="text-primary hover:underline"
                        >
                          Sign up
                        </button>
                      </div>
                    </div>
                  )}

                  {/* REGISTER — multi-step wizard */}
                  {mode === "register" && (
                    <div className="space-y-4">
                      <div className="relative">
                        <Separator />
                        <span className="absolute left-1/2 -translate-x-1/2 -top-2.5 bg-card px-2 text-[11px] text-muted-foreground">
                          create an account
                        </span>
                      </div>

                      {/* Step indicator */}
                      <div className="flex items-center gap-2">
                        {[1, 2, 3].map((s) => (
                          <div
                            key={s}
                            className="flex-1 flex items-center gap-2"
                          >
                            <div
                              className={`flex-1 h-1.5 rounded-full transition-colors duration-300 ${
                                s <= regStep ? "bg-primary" : "bg-muted"
                              }`}
                            />
                          </div>
                        ))}
                      </div>
                      <p className="text-center text-[11px] text-muted-foreground -mt-1">
                        Step {regStep} of 3 —{" "}
                        {regStep === 1
                          ? "Account"
                          : regStep === 2
                            ? "Identity"
                            : "Program"}
                      </p>

                      <form onSubmit={handleRegister} className="space-y-3">
                        {/* Step 1: Account (email + password + confirm) */}
                        {regStep === 1 && (
                          <div className="space-y-3 animate-in fade-in duration-200">
                            <div className="space-y-1.5">
                              <Label htmlFor="regEmail">Email</Label>
                              <div className="relative">
                                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                <Input
                                  id="regEmail"
                                  type="email"
                                  placeholder="yourname@gmail.com"
                                  value={email}
                                  onChange={(e) => setEmail(e.target.value)}
                                  className={`pl-9 pr-10 ${
                                    emailTaken
                                      ? "border-destructive focus-visible:ring-destructive"
                                      : debouncedEmail &&
                                          !emailChecking &&
                                          !emailTaken
                                        ? "border-emerald-500/50 focus-visible:ring-emerald-500/50"
                                        : ""
                                  }`}
                                  autoFocus
                                />
                                {/* Inline availability indicator */}
                                {debouncedEmail && (
                                  <span className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center">
                                    {emailChecking ? (
                                      <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />
                                    ) : emailTaken ? (
                                      <XCircle className="h-4 w-4 text-destructive" />
                                    ) : emailCheckFailed ? (
                                      <Info className="h-4 w-4 text-muted-foreground" />
                                    ) : (
                                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                                    )}
                                  </span>
                                )}
                              </div>
                              {errors.email ? (
                                <p
                                  className={`text-xs ${emailTaken ? "text-destructive" : "text-muted-foreground"}`}
                                >
                                  {errors.email}
                                </p>
                              ) : emailTaken ? (
                                <p className="text-xs text-destructive">
                                  This email is already registered
                                </p>
                              ) : emailCheckFailed ? (
                                <p className="text-xs text-muted-foreground">
                                  Couldn&apos;t verify — try again
                                </p>
                              ) : debouncedEmail && !emailChecking ? (
                                <p className="text-xs text-emerald-600 dark:text-emerald-400">
                                  Email is available
                                </p>
                              ) : null}
                            </div>
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-1.5">
                                <Label htmlFor="regPass">Password</Label>
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      Min 8 chars: uppercase, lowercase, number,
                                      special
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              </div>
                              <div className="relative">
                                <Input
                                  id="regPass"
                                  type={showRegPassword ? "text" : "password"}
                                  placeholder="••••••••"
                                  value={password}
                                  onChange={(e) => setPassword(e.target.value)}
                                  className="pr-10"
                                  autoComplete="new-password"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    setShowRegPassword(!showRegPassword)
                                  }
                                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                                >
                                  {showRegPassword ? (
                                    <EyeOff className="h-4 w-4" />
                                  ) : (
                                    <Eye className="h-4 w-4" />
                                  )}
                                </button>
                              </div>
                              <PasswordStrengthMeter password={password} />
                              {errors.password && (
                                <p className="text-xs text-destructive">
                                  {errors.password}
                                </p>
                              )}
                            </div>
                            <div className="space-y-1.5">
                              <Label htmlFor="confirmPass">
                                Confirm password
                              </Label>
                              <div className="relative">
                                <Input
                                  id="confirmPass"
                                  type="password"
                                  placeholder="••••••••"
                                  value={confirmPassword}
                                  onChange={(e) =>
                                    setConfirmPassword(e.target.value)
                                  }
                                  className={`pr-10 ${
                                    confirmPassword &&
                                    confirmPassword === password
                                      ? "border-emerald-500/50 focus-visible:ring-emerald-500/50"
                                      : confirmPassword &&
                                          confirmPassword !== password
                                        ? "border-destructive/50 focus-visible:ring-destructive/50"
                                        : ""
                                  }`}
                                  autoComplete="new-password"
                                />
                                {/* Real-time match indicator */}
                                {confirmPassword && (
                                  <span className="absolute right-3 top-1/2 -translate-y-1/2">
                                    {confirmPassword === password ? (
                                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                                    ) : (
                                      <XCircle className="h-4 w-4 text-destructive/60" />
                                    )}
                                  </span>
                                )}
                              </div>
                              {errors.confirmPassword ? (
                                <p className="text-xs text-destructive">
                                  {errors.confirmPassword}
                                </p>
                              ) : confirmPassword &&
                                confirmPassword === password ? (
                                <p className="text-xs text-emerald-600 dark:text-emerald-400">
                                  Passwords match
                                </p>
                              ) : null}
                            </div>
                            <Button
                              type="button"
                              className="w-full h-10"
                              onClick={() => {
                                if (validateRegStep(1)) {
                                  setErrors({});
                                  setRegStep(2);
                                }
                              }}
                            >
                              Continue
                              <ArrowRight className="h-4 w-4 ml-1" />
                            </Button>
                          </div>
                        )}

                        {/* Step 2: Identity (full name + student ID) */}
                        {regStep === 2 && (
                          <div className="space-y-3 animate-in fade-in duration-200">
                            <div className="space-y-1.5">
                              <Label htmlFor="fullName">Full name</Label>
                              <Input
                                id="fullName"
                                placeholder="Juan Dela Cruz"
                                value={fullName}
                                onChange={(e) =>
                                  setFullName(
                                    e.target.value.replace(/[0-9]/g, ""),
                                  )
                                }
                                autoFocus
                              />
                              {errors.fullName ? (
                                <p className="text-xs text-destructive">
                                  {errors.fullName}
                                </p>
                              ) : (
                                <p className="text-xs text-muted-foreground">
                                  Letters only — no numbers
                                </p>
                              )}
                            </div>
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-1.5">
                                <Label htmlFor="studentId">Student ID</Label>
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      7-digit number on your ID card or
                                      registration form
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              </div>
                              <div className="relative">
                                <Hash className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                <Input
                                  id="studentId"
                                  inputMode="numeric"
                                  placeholder="3240001"
                                  value={studentId}
                                  onChange={(e) =>
                                    setStudentId(
                                      e.target.value
                                        .replace(/\D/g, "")
                                        .slice(0, 7),
                                    )
                                  }
                                  className={`pl-9 pr-10 font-heading ${
                                    studentIdTaken
                                      ? "border-destructive focus-visible:ring-destructive"
                                      : debouncedStudentId &&
                                          !studentIdChecking &&
                                          !studentIdTaken
                                        ? "border-emerald-500/50 focus-visible:ring-emerald-500/50"
                                        : ""
                                  }`}
                                />
                                {/* Inline availability indicator */}
                                {debouncedStudentId && (
                                  <span className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center">
                                    {studentIdChecking ? (
                                      <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />
                                    ) : studentIdTaken ? (
                                      <XCircle className="h-4 w-4 text-destructive" />
                                    ) : studentIdCheckFailed ? (
                                      <Info className="h-4 w-4 text-muted-foreground" />
                                    ) : (
                                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                                    )}
                                  </span>
                                )}
                              </div>
                              {errors.studentId ? (
                                <p
                                  className={`text-xs ${studentIdTaken ? "text-destructive" : "text-muted-foreground"}`}
                                >
                                  {errors.studentId}
                                </p>
                              ) : studentIdTaken ? (
                                <p className="text-xs text-destructive">
                                  This student ID is already registered
                                </p>
                              ) : studentIdCheckFailed ? (
                                <p className="text-xs text-muted-foreground">
                                  Couldn&apos;t verify — try again
                                </p>
                              ) : debouncedStudentId && !studentIdChecking ? (
                                <p className="text-xs text-emerald-600 dark:text-emerald-400">
                                  Student ID is available
                                </p>
                              ) : null}
                            </div>
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                className="h-10"
                                onClick={() => {
                                  setErrors({});
                                  setRegStep(1);
                                }}
                              >
                                <ArrowLeft className="h-4 w-4 mr-1" />
                                Back
                              </Button>
                              <Button
                                type="button"
                                className="flex-1 h-10"
                                onClick={() => {
                                  if (validateRegStep(2)) {
                                    setErrors({});
                                    setRegStep(3);
                                  }
                                }}
                              >
                                Continue
                                <ArrowRight className="h-4 w-4 ml-1" />
                              </Button>
                            </div>
                          </div>
                        )}

                        {/* Step 3: Program (optional) + submit */}
                        {regStep === 3 && (
                          <div className="space-y-3 animate-in fade-in duration-200">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div className="space-y-1.5">
                                <Label htmlFor="program">Program</Label>
                                <Select
                                  value={program}
                                  onValueChange={setProgram}
                                >
                                  <SelectTrigger
                                    id="program"
                                    className="w-full"
                                  >
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
                              <div className="space-y-1.5">
                                <Label htmlFor="section">Section</Label>
                                <Input
                                  id="section"
                                  placeholder="e.g. 2-A, 3-B"
                                  value={section}
                                  onChange={(e) => setSection(e.target.value)}
                                />
                              </div>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Program and section are optional — you can set
                              them later in your profile.
                            </p>
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                className="h-10"
                                onClick={() => {
                                  setErrors({});
                                  setRegStep(2);
                                }}
                              >
                                <ArrowLeft className="h-4 w-4 mr-1" />
                                Back
                              </Button>
                              <Button
                                type="submit"
                                className="flex-1 h-10"
                                disabled={register.isPending}
                              >
                                {register.isPending ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <UserPlus className="h-4 w-4" />
                                )}
                                Create account
                              </Button>
                            </div>
                          </div>
                        )}
                      </form>
                      <div className="text-center text-sm">
                        <button
                          type="button"
                          onClick={() => {
                            setMode("login");
                            setErrors({});
                            setRegStep(1);
                          }}
                          className="text-muted-foreground hover:underline"
                        >
                          Already have an account? Sign in
                        </button>
                      </div>
                    </div>
                  )}

                  {/* REGISTRATION SUCCESS */}
                  {mode === "success" && (
                    <div className="space-y-5 text-center">
                      <motion.div
                        initial={{ scale: 0.6, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{
                          type: "spring",
                          stiffness: 200,
                          damping: 18,
                        }}
                        className="mx-auto grid place-items-center h-16 w-16 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      >
                        {needsEmailConfirmation ? (
                          <Mail className="h-9 w-9" />
                        ) : (
                          <CheckCircle2 className="h-9 w-9" />
                        )}
                      </motion.div>
                      <div className="space-y-1">
                        <p className="text-sm text-muted-foreground">
                          Account created for
                        </p>
                        <p className="font-heading font-semibold text-base break-all">
                          {registeredEmail || email}
                        </p>
                      </div>
                      {needsEmailConfirmation ? (
                        <>
                          <p className="text-sm text-muted-foreground">
                            We sent a confirmation link to your email. Click the
                            link to verify your account, then sign in.
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Didn&apos;t get the email? Check your spam folder,
                            or wait a minute for it to arrive.
                          </p>
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          Sign in with your email and password to activate your
                          account.
                        </p>
                      )}
                      <div className="space-y-2">
                        <Button
                          type="button"
                          className="w-full h-10"
                          onClick={() => {
                            setPassword("");
                            setErrors({});
                            setMode("login");
                          }}
                        >
                          {needsEmailConfirmation
                            ? "I've confirmed — sign in"
                            : "Continue to sign in"}
                          <ArrowRight className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* FORGOT PASSWORD */}
                  {mode === "forgot" && (
                    <form onSubmit={handleForgot} className="space-y-4">
                      <p className="text-sm text-muted-foreground">
                        Enter your account email and we'll send you a link to
                        reset your password.
                      </p>
                      <div className="space-y-1.5">
                        <Label htmlFor="forgotEmail">Email</Label>
                        <div className="relative">
                          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                          <Input
                            id="forgotEmail"
                            type="email"
                            autoComplete="email"
                            placeholder="yourname@gmail.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="pl-9"
                          />
                        </div>
                        {errors.email && (
                          <p className="text-xs text-destructive">
                            {errors.email}
                          </p>
                        )}
                      </div>
                      <Button
                        type="submit"
                        className="w-full h-10"
                        disabled={forgotPassword.isPending}
                      >
                        {forgotPassword.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Mail className="h-4 w-4" />
                        )}
                        Send reset link
                      </Button>
                      <button
                        type="button"
                        onClick={() => {
                          setMode("login");
                          setErrors({});
                        }}
                        className="w-full text-sm text-muted-foreground hover:text-primary flex items-center justify-center gap-1.5"
                      >
                        <ArrowLeft className="h-3.5 w-3.5" />
                        Back to sign in
                      </button>
                    </form>
                  )}

                  {/* FORGOT PASSWORD SUCCESS */}
                  {mode === "forgot-success" && (
                    <div className="space-y-5 text-center">
                      <motion.div
                        initial={{ scale: 0.6, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{
                          type: "spring",
                          stiffness: 200,
                          damping: 18,
                        }}
                        className="mx-auto grid place-items-center h-16 w-16 rounded-full bg-primary/15 text-primary"
                      >
                        <MailCheck className="h-9 w-9" />
                      </motion.div>
                      <div className="space-y-1">
                        <p className="text-sm text-muted-foreground">
                          Reset link sent to
                        </p>
                        <p className="font-heading font-semibold text-base break-all">
                          {forgotEmail || email}
                        </p>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        If an account with that email exists, you'll receive a
                        message with a link to choose a new password. The link
                        expires in 30 minutes.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full h-10"
                        onClick={() => {
                          setErrors({});
                          setMode("login");
                        }}
                      >
                        <ArrowLeft className="h-4 w-4" />
                        Back to sign in
                      </Button>
                    </div>
                  )}

                  {/* RESET PASSWORD */}
                  {mode === "reset" && (
                    <form onSubmit={handleReset} className="space-y-4">
                      {!resetToken && (
                        <div className="rounded-md bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive">
                          No reset token found. Please request a new password
                          reset link.
                        </div>
                      )}
                      <div className="space-y-1.5">
                        <Label htmlFor="newPass">New password</Label>
                        <div className="relative">
                          <Input
                            id="newPass"
                            type={showNewPassword ? "text" : "password"}
                            autoComplete="new-password"
                            placeholder="••••••••"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            className="pr-10"
                          />
                          <button
                            type="button"
                            onClick={() => setShowNewPassword(!showNewPassword)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                          >
                            {showNewPassword ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                        <PasswordStrengthMeter password={newPassword} />
                        {errors.newPassword && (
                          <p className="text-xs text-destructive">
                            {errors.newPassword}
                          </p>
                        )}
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="confirmNewPass">
                          Confirm new password
                        </Label>
                        <div className="relative">
                          <Input
                            id="confirmNewPass"
                            type="password"
                            autoComplete="new-password"
                            placeholder="••••••••"
                            value={confirmNewPassword}
                            onChange={(e) =>
                              setConfirmNewPassword(e.target.value)
                            }
                            className={`pr-10 ${
                              confirmNewPassword &&
                              confirmNewPassword === newPassword
                                ? "border-emerald-500/50 focus-visible:ring-emerald-500/50"
                                : confirmNewPassword &&
                                    confirmNewPassword !== newPassword
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
                        ) : confirmNewPassword &&
                          confirmNewPassword === newPassword ? (
                          <p className="text-xs text-emerald-600 dark:text-emerald-400">
                            Passwords match
                          </p>
                        ) : null}
                      </div>
                      <Button
                        type="submit"
                        className="w-full h-10"
                        disabled={resetPassword.isPending || !resetToken}
                      >
                        {resetPassword.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Lock className="h-4 w-4" />
                        )}
                        Reset password
                      </Button>
                      <button
                        type="button"
                        onClick={() => {
                          setErrors({});
                          setMode("login");
                        }}
                        className="w-full text-sm text-muted-foreground hover:text-primary flex items-center justify-center gap-1.5"
                      >
                        <ArrowLeft className="h-3.5 w-3.5" />
                        Back to sign in
                      </button>
                    </form>
                  )}

                  {/* RESET PASSWORD SUCCESS */}
                  {mode === "reset-success" && (
                    <div className="space-y-5 text-center">
                      <motion.div
                        initial={{ scale: 0.6, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{
                          type: "spring",
                          stiffness: 200,
                          damping: 18,
                        }}
                        className="mx-auto grid place-items-center h-16 w-16 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      >
                        <CheckCircle2 className="h-9 w-9" />
                      </motion.div>
                      <div className="space-y-1">
                        <p className="font-heading font-semibold text-base">
                          All set
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Your password has been reset. You can now sign in with
                          your new password.
                        </p>
                      </div>
                      <Button
                        type="button"
                        className="w-full h-10"
                        onClick={() => {
                          setPassword("");
                          setErrors({});
                          setMode("login");
                        }}
                      >
                        <LogIn className="h-4 w-4" />
                        Continue to sign in
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-border/40 px-6 py-4 text-center text-xs text-muted-foreground">
        Nexus Gate ·{" "}
        <button
          className="hover:text-primary underline"
          onClick={() => openInfoModal("terms")}
        >
          Terms
        </button>
        {" · "}
        <button
          className="hover:text-primary underline"
          onClick={() => openInfoModal("privacy")}
        >
          Privacy
        </button>
        {" · "}
        <button
          className="hover:text-primary underline"
          onClick={() => openInfoModal("faq")}
        >
          FAQ
        </button>
        {" · "}
        <button
          className="hover:text-primary underline"
          onClick={() => openInfoModal("bug")}
        >
          Report a bug
        </button>
      </footer>

      <CookieConsent />
      <InfoModals />
    </div>
  );
}

// ---- Animated background ----
function AuthBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {Array.from({ length: 12 }).map((_, i) => {
        const left = (i * 67) % 100;
        const delay = (i * 0.9) % 6;
        const duration = 10 + (i % 4) * 3;
        const size = 3 + (i % 3) * 2;
        return (
          <motion.div
            key={i}
            className="absolute rounded-full bg-primary"
            style={{
              left: `${left}%`,
              bottom: `-20px`,
              width: size,
              height: size,
              opacity: 0.06,
            }}
            animate={{ y: [0, -800], opacity: [0, 0.12, 0] }}
            transition={{ duration, delay, repeat: Infinity, ease: "linear" }}
          />
        );
      })}
      <div className="absolute top-0 -left-32 h-72 w-72 rounded-full bg-primary/8 blur-3xl" />
      <div className="absolute bottom-0 -right-32 h-72 w-72 rounded-full bg-primary/6 blur-3xl" />
    </div>
  );
}

// NexusLogo is imported from ./nexus-logo (shared with app-shell).
