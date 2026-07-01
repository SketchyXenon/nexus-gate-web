"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  FileText,
  Lock,
  HelpCircle,
  ShieldCheck,
  Mail,
  Cookie,
  Database,
  Eye,
  Clock,
  Trash2,
  KeyRound,
  Smartphone,
  QrCode,
  AlertTriangle,
  CheckCircle2,
  Bug,
  ExternalLink,
} from "lucide-react";

type ModalType = "terms" | "privacy" | "faq" | "bug" | null;

export function InfoModals() {
  const [open, setOpen] = useState<ModalType>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as ModalType;
      if (detail) setOpen(detail);
    };
    window.addEventListener("open-info-modal", handler);
    return () => window.removeEventListener("open-info-modal", handler);
  }, []);

  return (
    <AnimatePresence>
      {open && (
        <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
          <DialogContent className="max-w-2xl max-h-[85vh] p-0 overflow-hidden sm:rounded-xl rounded-lg">
            {/* Header band */}
            <div className="bg-primary/5 border-b border-border/40 px-4 sm:px-6 py-4 sm:py-5">
              <DialogHeader>
                <div className="flex items-center gap-3 mb-1">
                  <div className="grid place-items-center h-9 w-9 sm:h-10 sm:w-10 rounded-lg bg-primary/15 text-primary shrink-0">
                    {open === "terms" && <FileText className="h-4 w-4 sm:h-5 sm:w-5" />}
                    {open === "privacy" && <Lock className="h-4 w-4 sm:h-5 sm:w-5" />}
                    {open === "faq" && <HelpCircle className="h-4 w-4 sm:h-5 sm:w-5" />}
                    {open === "bug" && <Bug className="h-4 w-4 sm:h-5 sm:w-5" />}
                  </div>
                  <div className="min-w-0">
                    <DialogTitle className="font-heading text-lg sm:text-xl">
                      {open === "terms" && "Terms of Use"}
                      {open === "privacy" && "Privacy Policy"}
                      {open === "faq" && "Frequently Asked Questions"}
                      {open === "bug" && "Report a Bug"}
                    </DialogTitle>
                    <DialogDescription className="text-xs">
                      {open === "terms" && "Last updated: June 2026"}
                      {open === "privacy" && "Last updated: June 2026"}
                      {open === "faq" && "Quick answers to common questions"}
                      {open === "bug" && "Found a problem? Let the developer know."}
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>
            </div>

            {/* Content */}
            <ScrollArea className="max-h-[60vh] sm:max-h-[65vh]">
              <div className="px-4 sm:px-6 py-4 sm:py-5">
                {open === "terms" && <TermsContent />}
                {open === "privacy" && <PrivacyContent />}
                {open === "faq" && <FaqContent />}
                {open === "bug" && <BugContent />}
              </div>
            </ScrollArea>

            {/* Footer */}
            <div className="border-t border-border/40 px-4 sm:px-6 py-3 bg-muted/30 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">
                Questions? Contact your administrator.
              </p>
              <Badge variant="outline" className="text-[10px] gap-1 self-start sm:self-auto">
                <ShieldCheck className="h-3 w-3" /> Nexus Gate
              </Badge>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </AnimatePresence>
  );
}

// ---- Terms of Use ----
function TermsContent() {
  return (
    <div className="space-y-5 text-sm text-muted-foreground leading-relaxed">
      <PolicySection icon={<CheckCircle2 className="h-4 w-4" />} title="Using Nexus Gate">
        By using this system, you agree to these terms. If you don't agree, please don't use it.
        Nexus Gate is provided for attendance tracking.
      </PolicySection>

      <PolicySection icon={<KeyRound className="h-4 w-4" />} title="Your Account">
        You're responsible for keeping your password safe. You must provide accurate information
        when registering. Your student ID must match the official registrar records. Don't share
        your login with anyone.
      </PolicySection>

      <PolicySection icon={<AlertTriangle className="h-4 w-4" />} title="What You Can't Do">
        <ul className="space-y-1.5 mt-2">
          <li className="flex gap-2"><span className="text-destructive">•</span> Share your login details with classmates</li>
          <li className="flex gap-2"><span className="text-destructive">•</span> Try to bypass security measures</li>
          <li className="flex gap-2"><span className="text-destructive">•</span> Submit false attendance records</li>
          <li className="flex gap-2"><span className="text-destructive">•</span> Use another student's account</li>
        </ul>
        <p className="mt-2">Misuse may result in account suspension and disciplinary action.</p>
      </PolicySection>

      <PolicySection icon={<ClipboardList className="h-4 w-4" />} title="Attendance Records">
        Attendance records are final once submitted. If you believe a record is incorrect,
        contact your instructor to request a correction. Records are kept for the duration
        of your enrollment.
      </PolicySection>

      <PolicySection icon={<Clock className="h-4 w-4" />} title="Changes to These Terms">
        We may update these terms from time to time. Continued use after changes means you
        accept the updated terms.
      </PolicySection>

      <PolicySection icon={<Mail className="h-4 w-4" />} title="Contact">
        For questions about these terms, contact your administrator.
      </PolicySection>
    </div>
  );
}

// ---- Privacy Policy ----
function PrivacyContent() {
  return (
    <div className="space-y-5 text-sm text-muted-foreground leading-relaxed">
      <div className="rounded-lg bg-primary/5 border border-primary/20 p-4">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <p className="font-heading font-semibold text-foreground text-sm">Your privacy matters</p>
        </div>
        <p className="text-xs">We collect only what's needed for attendance. We never sell your data.</p>
      </div>

      <PolicySection icon={<Database className="h-4 w-4" />} title="What We Collect">
        <ul className="space-y-1 mt-2">
          <li className="flex gap-2"><span className="text-primary">•</span> Name, email, student ID, program, and section</li>
          <li className="flex gap-2"><span className="text-primary">•</span> Attendance records (when you scanned)</li>
          <li className="flex gap-2"><span className="text-primary">•</span> Login times (for security)</li>
        </ul>
        <p className="mt-2">All of this comes from the registrar or is generated when you use the system.</p>
      </PolicySection>

      <PolicySection icon={<Eye className="h-4 w-4" />} title="How We Use Your Data">
        Only for attendance tracking and account security. We use it to:
        <ul className="space-y-1 mt-2">
          <li className="flex gap-2"><span className="text-primary">•</span> Record your attendance in classes</li>
          <li className="flex gap-2"><span className="text-primary">•</span> Keep your account secure</li>
          <li className="flex gap-2"><span className="text-primary">•</span> Generate attendance reports for teachers</li>
        </ul>
      </PolicySection>

      <PolicySection icon={<Cookie className="h-4 w-4" />} title="Cookies">
        We use cookies only to keep you signed in and remember your theme preference (dark or light).
        No tracking cookies. No advertising cookies. No third-party cookies.
      </PolicySection>

      <PolicySection icon={<Lock className="h-4 w-4" />} title="Data Security">
        Your password is encrypted. All data is stored securely. Access is restricted by role —
        only administrators can see all accounts. Teachers can only see attendance for their own events.
      </PolicySection>

      <PolicySection icon={<ShieldCheck className="h-4 w-4" />} title="Who Can See Your Data">
        <ul className="space-y-1 mt-2">
          <li className="flex gap-2"><span className="text-primary">•</span> <strong className="text-foreground">You</strong> — your own attendance history</li>
          <li className="flex gap-2"><span className="text-primary">•</span> <strong className="text-foreground">Your teachers</strong> — attendance for their events only</li>
          <li className="flex gap-2"><span className="text-primary">•</span> <strong className="text-foreground">Administrators</strong> — all accounts and records</li>
        </ul>
        <p className="mt-2">No one else. We never share your data with third parties.</p>
      </PolicySection>

      <PolicySection icon={<Trash2 className="h-4 w-4" />} title="Data Retention">
        Attendance records are kept for the duration of your enrollment and archived per
        university policy. You can request a copy of your data or ask for corrections by
        contacting the registrar's office.
      </PolicySection>
    </div>
  );
}

// ---- FAQ ----
function FaqContent() {
  return (
    <div className="space-y-3">
      <FaqItem icon={<QrCode className="h-4 w-4" />} q="How do I check in to a class?">
        Log in, go to the Scanner page, and point your camera at the QR code on the classroom screen.
        Your attendance is recorded instantly.
      </FaqItem>

      <FaqItem icon={<Smartphone className="h-4 w-4" />} q="What if I don't have my phone?">
        Ask your teacher to add you manually. They can mark you present through the manual entry feature.
      </FaqItem>

      <FaqItem icon={<Smartphone className="h-4 w-4" />} q="Can I log in from any device?">
        Yes. Sign in from your phone, tablet, or computer. Your account is tied to your student ID,
        not a specific device.
      </FaqItem>

      <FaqItem icon={<KeyRound className="h-4 w-4" />} q="What is my student ID?">
        A 7-digit number (e.g. 3240001). Find it on your registration form or school ID card.
      </FaqItem>

      <FaqItem icon={<AlertTriangle className="h-4 w-4" />} q="I can't log in. What should I do?">
        First, make sure your email is verified. If you forgot your password, contact an administrator.
        After 5 failed attempts, your account will be locked for 15 minutes.
      </FaqItem>

      <FaqItem icon={<QrCode className="h-4 w-4" />} q="Is the QR code safe to share?">
        The code changes every 15 seconds. A screenshot becomes useless after that, so sharing it
        won't work.
      </FaqItem>

      <FaqItem icon={<CheckCircle2 className="h-4 w-4" />} q="Can I sign in with Google?">
        Yes. Click "Continue with Google" on the sign-in page. Your email must match the one on the
        approved student list.
      </FaqItem>

      <FaqItem icon={<Mail className="h-4 w-4" />} q="Who do I contact for help?">
        Contact your administrator for any issues with your account
        or attendance records.
      </FaqItem>
    </div>
  );
}

// ---- Reusable components ----
function PolicySection({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="text-primary">{icon}</div>
        <h4 className="font-heading font-semibold text-foreground text-sm">{title}</h4>
      </div>
      <div className="pl-6">{children}</div>
    </div>
  );
}

function FaqItem({
  icon,
  q,
  children,
}: {
  icon: React.ReactNode;
  q: string;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-border/50 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-accent/40 transition-colors"
      >
        <div className="text-primary shrink-0">{icon}</div>
        <span className="font-heading font-medium text-foreground text-sm flex-1">{q}</span>
        <motion.div
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={{ duration: 0.2 }}
        >
          <svg className="h-4 w-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </motion.div>
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <p className="px-4 pb-4 pl-11 text-sm text-muted-foreground leading-relaxed">
              {children}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---- Report a Bug ----
function BugContent() {
  return (
    <div className="space-y-5 text-sm text-muted-foreground leading-relaxed">
      <div className="rounded-lg bg-primary/5 border border-primary/20 p-4">
        <div className="flex items-center gap-2 mb-1">
          <Bug className="h-4 w-4 text-primary" />
          <p className="font-heading font-semibold text-foreground text-sm">Spotted a bug?</p>
        </div>
        <p className="text-xs">
          Your feedback helps make Nexus Gate better for everyone. If you found
          something that's not working right, please reach out.
        </p>
      </div>

      <PolicySection icon={<AlertTriangle className="h-4 w-4" />} title="What to include">
        <ul className="space-y-1 mt-2">
          <li className="flex gap-2"><span className="text-primary">•</span> What you were trying to do</li>
          <li className="flex gap-2"><span className="text-primary">•</span> What happened instead</li>
          <li className="flex gap-2"><span className="text-primary">•</span> What device and browser you're using</li>
          <li className="flex gap-2"><span className="text-primary">•</span> The time it happened (if you remember)</li>
        </ul>
      </PolicySection>

      <PolicySection icon={<Mail className="h-4 w-4" />} title="Contact the developer">
        <p className="mt-2">
          You can reach the developer directly through the portfolio website below.
          Send a message describing the issue and it'll be looked into as soon as possible.
        </p>
        <a
          href="https://ray-abenasa.vercel.app/"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-4 py-2.5 text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <ExternalLink className="h-4 w-4" />
          Visit ray-abenasa.vercel.app
        </a>
      </PolicySection>

      <PolicySection icon={<CheckCircle2 className="h-4 w-4" />} title="Thank you">
        Every report helps fix issues faster and makes the system more reliable
        for all students and teachers. We appreciate you taking the time.
      </PolicySection>
    </div>
  );
}

// Helper to open modals from anywhere
export function openInfoModal(type: "terms" | "privacy" | "faq" | "bug") {
  window.dispatchEvent(new CustomEvent("open-info-modal", { detail: type }));
}

// Icon import helper for PolicySection
function ClipboardList({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M12 11h4" />
      <path d="M12 16h4" />
      <path d="M8 11h.01" />
      <path d="M8 16h.01" />
    </svg>
  );
}
