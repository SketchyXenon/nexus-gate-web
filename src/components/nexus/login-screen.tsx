"use client";

import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { signIn as nextAuthSignIn } from "next-auth/react";
import {
  ShieldCheck,
  ScanLine,
  LogIn,
  UserPlus,
  ArrowLeft,
  ArrowRight,
  Loader2,
  Mail,
  MailCheck,
  CheckCircle2,
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
import { TurnstileField, type TurnstileFieldRef } from "./turnstile-field";
import { PROGRAMS } from "@/lib/programs";
import {
  useLogin,
  useRegister,
  useForgotPassword,
  useResetPassword,
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

  // If we recovered a token, jump straight into the reset flow on mount.
  const [mode, setMode] = useState<Mode>(resetToken ? "reset" : initialMode);

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
  const [googleLoading, setGoogleLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  // New-password fields for the reset flow.
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  // Remembers the email used in the forgot-password form so we can echo it
  // back on the "Check your email" success screen.
  const [forgotEmail, setForgotEmail] = useState("");
  // Remembers the email used at registration so the success screen can
  // show "Account created for <email>" even if the user edited the field.
  const [registeredEmail, setRegisteredEmail] = useState("");
  // Cloudflare Turnstile tokens for the login + register forms.
  // These are verified SERVER-SIDE via Cloudflare's siteverify API —
  // this is the real anti-bot boundary, not the client-side gate.
  const [loginCfToken, setLoginCfToken] = useState("");
  const [registerCfToken, setRegisterCfToken] = useState("");
  const loginTurnstileRef = useRef<TurnstileFieldRef>(null);
  const registerTurnstileRef = useRef<TurnstileFieldRef>(null);

  const login = useLogin();
  const register = useRegister();
  const forgotPassword = useForgotPassword();
  const resetPassword = useResetPassword();

  async function handleGoogleSignIn() {
    setGoogleLoading(true);
    try {
      await nextAuthSignIn("google", { callbackUrl: "/" });
    } catch {
      setGoogleLoading(false);
    }
    // If nextAuthSignIn succeeds, the page redirects — no need to reset.
    // Reset only on error (popup blocked, user cancel, etc.)
  }

  // ---- Passkey sign-in (WebAuthn) ----
  // Does NOT conflict with password login — the server-side anti-account-sharing
  // logic revokes previous sessions on any new login (passkey or password).
  // If a student logs in with passkey, any existing password session is revoked,
  // and vice versa. Only one session per account at a time.
  async function handlePasskeySignIn() {
    setPasskeyLoading(true);
    try {
      // Step 1: Get authentication options from server
      const optionsRes = await fetch("/api/auth/passkey/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!optionsRes.ok)
        throw new Error("Failed to start passkey authentication");
      const options = await optionsRes.json();

      // Step 2: Trigger the browser's WebAuthn UI
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const assertion = await startAuthentication(options);

      // Step 3: Send the assertion to the server for verification
      const verifyRes = await fetch("/api/auth/passkey/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion }),
      });

      if (!verifyRes.ok) {
        const data = await verifyRes.json().catch(() => ({}));
        throw new Error(data.error || "Passkey verification failed");
      }

      // Success — the server set the session cookie
      toast({ title: "Signed in with passkey!" });
      // Force page reload to pick up the new session
      window.location.reload();
    } catch (e) {
      // User cancelled or verification failed
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

  function validateRegister() {
    const e: Record<string, string> = {};
    if (!fullName.trim()) e.fullName = "Enter your full name";
    if (!/^\d{7}$/.test(studentId.trim())) e.studentId = "Must be 7 digits";
    if (!email) e.email = "Enter your email";
    if (password.length < 8) e.password = "At least 8 characters";
    if (password !== confirmPassword)
      e.confirmPassword = "Passwords don't match";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function validateReset() {
    const e: Record<string, string> = {};
    if (newPassword.length < 8) e.newPassword = "At least 8 characters";
    if (newPassword !== confirmNewPassword)
      e.confirmNewPassword = "Passwords don't match";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!validateLogin()) return;
    login.mutate(
      { email, password, cfToken: loginCfToken },
      {
        onSuccess: () => toast({ title: "Welcome back!" }),
        onError: (err) => {
          // Reset the Turnstile widget so it produces a fresh token for
          // the next attempt (tokens are single-use).
          loginTurnstileRef.current?.reset();
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
    if (!validateRegister()) return;
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
        cfToken: registerCfToken,
      },
      {
        onSuccess: (data) => {
          setRegisteredEmail(data.email || email);
          setMode("success");
          toast({
            title: "Account created!",
            description: data.whitelisted
              ? "Your student ID was found on the approved list. Sign in to activate your account."
              : "Sign in to activate your account.",
          });
        },
        onError: (err) => {
          // Reset the Turnstile widget for the next attempt.
          registerTurnstileRef.current?.reset();
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
      { token: resetToken, password: newPassword },
      {
        onSuccess: () => {
          // The token is single-use — clear it so it can't be replayed.
          onResetConsumed();
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
                    {mode === "success" && "Account ready"}
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
                          className="w-full h-11 bg-white text-gray-900 hover:bg-gray-100 border border-gray-300 transition-all hover:scale-[1.01]"
                          onClick={handleGoogleSignIn}
                          disabled={googleLoading}
                        >
                          {googleLoading ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <GoogleIcon className="h-5 w-5" />
                          )}
                          Continue with Google
                        </Button>
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
                      </div>
                      <div className="relative">
                        <Separator />
                        <span className="absolute left-1/2 -translate-x-1/2 -top-2.5 bg-card px-2 text-[11px] text-muted-foreground">
                          or email
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
                        <TurnstileField
                          ref={loginTurnstileRef}
                          onToken={setLoginCfToken}
                        />
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

                  {/* REGISTER */}
                  {mode === "register" && (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Button
                          className="w-full h-11 bg-white text-gray-900 hover:bg-gray-100 border border-gray-300 transition-all hover:scale-[1.01]"
                          onClick={handleGoogleSignIn}
                          disabled={googleLoading}
                        >
                          {googleLoading ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <GoogleIcon className="h-5 w-5" />
                          )}
                          Sign up with Google
                        </Button>
                      </div>
                      <div className="relative">
                        <Separator />
                        <span className="absolute left-1/2 -translate-x-1/2 -top-2.5 bg-card px-2 text-[11px] text-muted-foreground">
                          or email
                        </span>
                      </div>
                      <form onSubmit={handleRegister} className="space-y-3">
                        <div className="space-y-1.5">
                          <Label htmlFor="fullName">Full name</Label>
                          <Input
                            id="fullName"
                            placeholder="Juan Dela Cruz"
                            value={fullName}
                            onChange={(e) =>
                              setFullName(e.target.value.replace(/[0-9]/g, ""))
                            }
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
                                  7-digit number on your ID card or registration
                                  form
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
                                  e.target.value.replace(/\D/g, "").slice(0, 7),
                                )
                              }
                              className="pl-9 font-heading"
                            />
                          </div>
                          {errors.studentId && (
                            <p className="text-xs text-destructive">
                              {errors.studentId}
                            </p>
                          )}
                        </div>
                        {/* Program + Section — stack on mobile, two-up on small+ screens */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="space-y-1.5">
                            <Label htmlFor="program">Program</Label>
                            <Select value={program} onValueChange={setProgram}>
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
                          <div className="flex items-center gap-1.5">
                            <Label htmlFor="regPass">Password</Label>
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                                </TooltipTrigger>
                                <TooltipContent>
                                  Min 8 chars: uppercase, lowercase, number
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
                          <Label htmlFor="confirmPass">Confirm</Label>
                          <Input
                            id="confirmPass"
                            type="password"
                            placeholder="••••••••"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            autoComplete="new-password"
                          />
                          {errors.confirmPassword && (
                            <p className="text-xs text-destructive">
                              {errors.confirmPassword}
                            </p>
                          )}
                        </div>
                        <TurnstileField
                          ref={registerTurnstileRef}
                          onToken={setRegisterCfToken}
                        />
                        <Button
                          type="submit"
                          className="w-full h-10 transition-all hover:scale-[1.01]"
                          disabled={register.isPending}
                        >
                          {register.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <UserPlus className="h-4 w-4" />
                          )}
                          Create account
                        </Button>
                      </form>
                      <div className="text-center text-sm">
                        <button
                          type="button"
                          onClick={() => {
                            setMode("login");
                            setErrors({});
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
                        <CheckCircle2 className="h-9 w-9" />
                      </motion.div>
                      <div className="space-y-1">
                        <p className="text-sm text-muted-foreground">
                          Account created for
                        </p>
                        <p className="font-heading font-semibold text-base break-all">
                          {registeredEmail || email}
                        </p>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Sign in with your email and password to activate your
                        account.
                      </p>
                      <div className="space-y-2">
                        <Button
                          type="button"
                          className="w-full h-10"
                          onClick={() => {
                            // Email state is already populated from registration,
                            // so the login form will be pre-filled.
                            setPassword("");
                            setErrors({});
                            setMode("login");
                          }}
                        >
                          Continue to sign in
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
                            type={showConfirmNewPassword ? "text" : "password"}
                            autoComplete="new-password"
                            placeholder="••••••••"
                            value={confirmNewPassword}
                            onChange={(e) =>
                              setConfirmNewPassword(e.target.value)
                            }
                            className="pr-10"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setShowConfirmNewPassword(!showConfirmNewPassword)
                            }
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                          >
                            {showConfirmNewPassword ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                        {errors.confirmNewPassword && (
                          <p className="text-xs text-destructive">
                            {errors.confirmNewPassword}
                          </p>
                        )}
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

// ---- Nexus Gate Logo (matches favicon) ----
function NexusLogo({ className }: { className?: string }) {
  return (
    <div
      className={`${className} grid place-items-center rounded-lg bg-primary text-primary-foreground ng-glow`}
    >
      <svg
        viewBox="0 0 192 192"
        className="w-3/5 h-3/5"
        fill="none"
        stroke="currentColor"
        strokeWidth="12"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M96 32 L152 52 V96 C152 128 128 152 96 160 C64 152 40 128 40 96 V52 Z" />
        <rect
          x="72"
          y="72"
          width="14"
          height="14"
          fill="currentColor"
          stroke="none"
        />
        <rect
          x="106"
          y="72"
          width="14"
          height="14"
          fill="currentColor"
          stroke="none"
        />
        <rect
          x="72"
          y="106"
          width="14"
          height="14"
          fill="currentColor"
          stroke="none"
        />
        <rect
          x="106"
          y="106"
          width="14"
          height="14"
          fill="currentColor"
          stroke="none"
        />
      </svg>
    </div>
  );
}

// ---- Google logo icon ----
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}
