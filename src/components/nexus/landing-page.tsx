"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ShieldCheck,
  ScanLine,
  WifiOff,
  RefreshCw,
  Smartphone,
  Lock,
  Zap,
  HelpCircle,
  FileText,
  ChevronDown,
  ArrowRight,
  Menu,
  X,
  LogIn,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Separator } from "@/components/ui/separator";
import { ThemeToggle } from "./theme-toggle";
import { CookieConsent } from "./cookie-consent";
import { InfoModals, openInfoModal } from "./info-modals";
import { NexusLogo } from "./nexus-logo";

interface LandingPageProps {
  onSignIn: () => void;
  onRegister: () => void;
}

export function LandingPage({ onSignIn, onRegister }: LandingPageProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-border/40 bg-background/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <NexusLogo size={36} />
            <span className="font-heading font-bold text-lg tracking-tight">
              Nexus Gate
            </span>
          </div>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openInfoModal("faq")}
            >
              <HelpCircle className="h-4 w-4" /> FAQ
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openInfoModal("terms")}
            >
              <FileText className="h-4 w-4" /> Terms
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openInfoModal("privacy")}
            >
              <Lock className="h-4 w-4" /> Privacy
            </Button>
            <ThemeToggle />
            <Button variant="ghost" size="sm" onClick={onSignIn}>
              Sign in
            </Button>
            <Button size="sm" onClick={onRegister}>
              Get started
            </Button>
          </div>

          {/* Mobile nav (hamburger) */}
          <div className="flex md:hidden items-center gap-1">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={() => setMobileMenuOpen(true)}
            >
              <Menu className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* Mobile menu dropdown — half-screen panel on the right */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <>
              {/* Backdrop */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="md:hidden fixed inset-0 h-[100dvh] z-40 bg-black/30"
                onClick={() => setMobileMenuOpen(false)}
              />
              {/* Panel — right half of screen */}
              <motion.div
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 250 }}
                className="md:hidden fixed top-0 right-0 h-[100dvh] w-1/2 min-w-[200px] max-w-[280px] z-50 bg-background/95 backdrop-blur-xl border-l border-border shadow-2xl flex flex-col"
              >
                {/* Panel header */}
                <div className="flex items-center justify-between p-4 border-b border-border/40">
                  <span className="font-heading font-semibold text-sm">
                    Menu
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                {/* Menu items */}
                <div className="flex-1 p-3 space-y-1 overflow-y-auto ng-scroll">
                  <button
                    onClick={() => {
                      openInfoModal("faq");
                      setMobileMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent/50 transition-colors text-sm"
                  >
                    <HelpCircle className="h-4 w-4 text-muted-foreground" /> FAQ
                  </button>
                  <button
                    onClick={() => {
                      openInfoModal("terms");
                      setMobileMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent/50 transition-colors text-sm"
                  >
                    <FileText className="h-4 w-4 text-muted-foreground" /> Terms
                  </button>
                  <button
                    onClick={() => {
                      openInfoModal("privacy");
                      setMobileMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent/50 transition-colors text-sm"
                  >
                    <Lock className="h-4 w-4 text-muted-foreground" /> Privacy
                  </button>
                  <Separator className="my-2" />
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => {
                      onSignIn();
                      setMobileMenuOpen(false);
                    }}
                  >
                    <LogIn className="h-4 w-4" /> Sign in
                  </Button>
                  <Button
                    className="w-full justify-start"
                    onClick={() => {
                      onRegister();
                      setMobileMenuOpen(false);
                    }}
                  >
                    <UserPlus className="h-4 w-4" /> Get started
                  </Button>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden flex-1 flex items-center justify-center px-4 py-20 sm:py-28">
        <AnimatedBackground />
        <div className="relative z-10 max-w-3xl mx-auto text-center">
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="font-heading text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight leading-[1.1]"
          >
            Attendance,
            <br />
            <span className="bg-gradient-to-r from-primary via-primary to-primary/60 bg-clip-text text-transparent">
              simplified.
            </span>
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="mt-6 text-base sm:text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed"
          >
            No more sign-in sheets or long lines. Your teacher shows a code, you
            scan it with your phone, and you&apos;re marked present. It takes less
            than a second.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="mt-8 flex flex-col sm:flex-row gap-3 justify-center"
          >
            <Button
              size="lg"
              className="h-12 px-8 text-base shadow-lg shadow-primary/20 hover:shadow-primary/30 transition-shadow"
              onClick={onRegister}
            >
              Create account <ArrowRight className="h-4 w-4" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-12 px-8 text-base"
              onClick={onSignIn}
            >
              Sign in
            </Button>
          </motion.div>
        </div>
      </section>

      {/* How it works */}
      <section className="px-4 py-16 sm:py-20 border-t border-border/40">
        <div className="max-w-5xl mx-auto">
          <h2 className="font-heading text-2xl sm:text-3xl font-bold text-center mb-12">
            How it works
          </h2>
          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                icon: ScanLine,
                title: "Your teacher shows a code",
                desc: "A QR code appears on the classroom screen. It changes every 15 seconds.",
              },
              {
                icon: Smartphone,
                title: "You scan it with your phone",
                desc: "Open this website, tap scan, and point your camera at the screen.",
              },
              {
                icon: ShieldCheck,
                title: "You're marked present",
                desc: "Your attendance is recorded instantly. No waiting, no paperwork.",
              },
            ].map((step, i) => {
              const Icon = step.icon;
              return (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: i * 0.1 }}
                  className="relative"
                >
                  <Card className="h-full hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5 transition-all duration-300 group">
                    <CardContent className="p-6">
                      <div className="flex items-center gap-3 mb-3">
                        <div className="relative grid place-items-center h-10 w-10 rounded-lg bg-primary/10 text-primary group-hover:bg-primary/15 group-hover:scale-110 transition-all duration-300">
                          <Icon className="h-5 w-5" />
                        </div>
                        <span className="font-heading text-sm font-bold text-muted-foreground">
                          Step {i + 1}
                        </span>
                        {i < 2 && (
                          <div className="hidden md:block absolute -right-3 top-1/2 -translate-y-1/2 text-muted-foreground/30 z-10">
                            <ArrowRight className="h-4 w-4" />
                          </div>
                        )}
                      </div>
                      <h3 className="font-heading font-semibold mb-1">
                        {step.title}
                      </h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {step.desc}
                      </p>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="px-4 py-16 sm:py-20 border-t border-border/40 bg-muted/20">
        <div className="max-w-5xl mx-auto">
          <h2 className="font-heading text-2xl sm:text-3xl font-bold text-center mb-12">
            Why students and teachers love it
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              {
                icon: WifiOff,
                title: "Works offline",
                desc: "No signal? No problem. Your scan is saved and sent when you reconnect.",
              },
              {
                icon: RefreshCw,
                title: "Changes every 15 seconds",
                desc: "The code refreshes constantly, so screenshots are useless.",
              },
              {
                icon: Smartphone,
                title: "Any device, anywhere",
                desc: "Phone, tablet, or laptop. No app to install — just a website.",
              },
              {
                icon: Lock,
                title: "Safe and private",
                desc: "Your data is encrypted and never sold. Only your school can see it.",
              },
              {
                icon: Zap,
                title: "Lightning fast",
                desc: "From scan to recorded in under a second. No more waiting in line.",
              },
              {
                icon: ShieldCheck,
                title: "Can't be faked",
                desc: "Each student can only check in once per class. No proxy sign-ins.",
              },
            ].map((f, i) => {
              const Icon = f.icon;
              return (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, scale: 0.95 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.05 }}
                  className="group relative flex gap-3 p-4 rounded-xl border border-border/50 bg-card hover:border-primary/30 hover:shadow-md hover:shadow-primary/5 transition-all duration-300"
                >
                  <div className="grid place-items-center h-10 w-10 rounded-lg bg-primary/10 text-primary shrink-0 group-hover:bg-primary/15 group-hover:scale-110 transition-all duration-300">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-heading font-semibold text-sm">
                      {f.title}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                      {f.desc}
                    </p>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="px-4 py-16 sm:py-20 border-t border-border/40">
        <div className="max-w-3xl mx-auto">
          <h2 className="font-heading text-2xl sm:text-3xl font-bold text-center mb-2">
            Questions?
          </h2>
          <p className="text-center text-muted-foreground mb-10 text-sm">
            Here are the most common ones. Still stuck? Ask your teacher.
          </p>
          <Accordion type="single" collapsible className="space-y-3">
            {FAQS.map((faq, i) => (
              <AccordionItem
                key={i}
                value={`item-${i}`}
                className="border rounded-lg px-4 data-[state=open]:border-primary/40 transition-colors"
              >
                <AccordionTrigger className="font-heading font-semibold text-left hover:no-underline">
                  {faq.q}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground leading-relaxed">
                  {faq.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* Terms & Privacy */}
      <section className="px-4 py-16 sm:py-20 border-t border-border/40 bg-muted/20">
        <div className="max-w-4xl mx-auto">
          <h2 className="font-heading text-2xl sm:text-3xl font-bold text-center mb-10">
            The fine print
          </h2>
          <div className="grid md:grid-cols-2 gap-6">
            <Card>
              <CardContent className="p-6">
                <h3 className="font-heading font-semibold mb-3 flex items-center gap-2">
                  <FileText className="h-4 w-4 text-primary" /> Terms of Use
                </h3>
                <div className="space-y-3 text-xs text-muted-foreground leading-relaxed">
                  <p>
                    <strong className="text-foreground">Your account.</strong>{" "}
                    You're responsible for keeping your password safe. Your
                    student ID must match the registrar's records.
                  </p>
                  <p>
                    <strong className="text-foreground">Fair use.</strong> Don't
                    share login details or try to fake attendance. Misuse may
                    lead to suspension.
                  </p>
                  <p>
                    <strong className="text-foreground">Records.</strong>{" "}
                    Attendance is final once submitted. Contact your teacher if
                    something's wrong.
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-4 -ml-2 text-primary"
                  onClick={() => openInfoModal("terms")}
                >
                  Read full terms <ArrowRight className="h-3 w-3" />
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                <h3 className="font-heading font-semibold mb-3 flex items-center gap-2">
                  <Lock className="h-4 w-4 text-primary" /> Privacy Policy
                </h3>
                <div className="space-y-3 text-xs text-muted-foreground leading-relaxed">
                  <p>
                    <strong className="text-foreground">
                      What we collect.
                    </strong>{" "}
                    Name, email, student ID, program, and section — all from the
                    registrar.
                  </p>
                  <p>
                    <strong className="text-foreground">How we use it.</strong>{" "}
                    Only for attendance and account security. We never sell your
                    data.
                  </p>
                  <p>
                    <strong className="text-foreground">Cookies.</strong> Just
                    to keep you signed in and remember your theme. No tracking.
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-4 -ml-2 text-primary"
                  onClick={() => openInfoModal("privacy")}
                >
                  Read full policy <ArrowRight className="h-3 w-3" />
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-4 py-20 border-t border-border/40">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="font-heading text-3xl sm:text-4xl font-bold mb-4">
            Ready to check in?
          </h2>
          <p className="text-muted-foreground mb-8">
            Create your account in under a minute. All you need is your 7-digit
            student ID.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button
              size="lg"
              className="h-12 px-8 text-base"
              onClick={onRegister}
            >
              Create account <ArrowRight className="h-4 w-4" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-12 px-8 text-base"
              onClick={onSignIn}
            >
              I already have one
            </Button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="mt-auto border-t border-border/40 bg-muted/20">
        <div className="max-w-6xl mx-auto px-4 py-8">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <NexusLogo size={32} />
              <div>
                <p className="font-heading font-semibold text-sm">Nexus Gate</p>
                <p className="text-[11px] text-muted-foreground">
                  Attendance System
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <button
                className="hover:text-primary transition-colors"
                onClick={() => openInfoModal("terms")}
              >
                Terms
              </button>
              <Separator orientation="vertical" className="h-4" />
              <button
                className="hover:text-primary transition-colors"
                onClick={() => openInfoModal("privacy")}
              >
                Privacy
              </button>
              <Separator orientation="vertical" className="h-4" />
              <button
                className="hover:text-primary transition-colors"
                onClick={() => openInfoModal("faq")}
              >
                FAQ
              </button>
              <Separator orientation="vertical" className="h-4" />
              <button
                className="hover:text-primary transition-colors"
                onClick={() => openInfoModal("bug")}
              >
                Report a bug
              </button>
            </div>
          </div>
          <Separator className="my-4" />
          <p className="text-center text-[11px] text-muted-foreground">
            Built with care for students and faculty.{" "}
            <a
              href="https://ray-abenasa.vercel.app/"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-primary transition-colors underline"
            >
              Contact the developer
            </a>
          </p>
        </div>
      </footer>

      <CookieConsent />
      <InfoModals />
    </div>
  );
}

// ---- Animated background: floating amber dots ----
function AnimatedBackground() {
  const dots = Array.from({ length: 20 });
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {/* Floating dots */}
      {dots.map((_, i) => {
        const left = (i * 53) % 100;
        const delay = (i * 0.7) % 8;
        const duration = 8 + (i % 5) * 2;
        const size = 4 + (i % 3) * 3;
        return (
          <motion.div
            key={i}
            className="absolute rounded-full bg-primary"
            style={{
              left: `${left}%`,
              bottom: `-20px`,
              width: size,
              height: size,
              opacity: 0.08 + (i % 3) * 0.04,
            }}
            animate={{
              y: [0, -1000],
              opacity: [0, 0.15, 0],
            }}
            transition={{
              duration,
              delay,
              repeat: Infinity,
              ease: "linear",
            }}
          />
        );
      })}
      {/* Glow orbs */}
      <div className="absolute top-1/4 -left-32 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
      <div className="absolute bottom-1/4 -right-32 h-80 w-80 rounded-full bg-primary/5 blur-3xl" />
    </div>
  );
}

const FAQS = [
  {
    q: "How do I check in to a class?",
    a: "Log in, go to the Scanner page, and point your camera at the QR code shown on the classroom screen. Your attendance is recorded instantly.",
  },
  {
    q: "What if I don't have my phone?",
    a: "Ask your teacher to add you manually. They can mark you present through the manual entry feature.",
  },
  {
    q: "Can I log in from any device?",
    a: "Yes. You can sign in from your phone, tablet, or computer. Your account is tied to your student ID, not a specific device.",
  },
  {
    q: "What is my student ID?",
    a: "Your student ID is a 7-digit number (e.g. 3240001). You can find it on your registration form or school ID card.",
  },
  {
    q: "I can't log in. What should I do?",
    a: "First, make sure your email is verified. If you forgot your password, contact an administrator. After 5 failed attempts, your account will be locked for 15 minutes.",
  },
  {
    q: "Is the QR code safe to share?",
    a: "The code changes every 15 seconds. A screenshot becomes useless after that window, so sharing it will not work.",
  },
  {
    q: "Can I sign in without a password?",
    a: "Yes. Use a passkey (fingerprint, face, or security key) or a magic link sent to your email. Both are available on the sign-in page.",
  },
  {
    q: "Who do I contact for help?",
    a: "Contact your administrator for any issues with your account or attendance records.",
  },
];
