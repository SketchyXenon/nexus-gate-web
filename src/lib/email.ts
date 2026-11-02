// ====================================================================
// Nexus Gate - Email Service (optional SMTP fallback)
//
// Email verification and password reset are handled by Supabase Auth's
// built-in email service. This module provides an OPTIONAL SMTP fallback
// for environments that want to route transactional email through a
// custom SMTP server (e.g. Gmail App Password) instead of Supabase.
//
// It is NOT required for the core auth flow to work.
// ====================================================================

// @types/nodemailer v8 dropped the `nodemailer` namespace in favour of
// named exports - import the Transporter TYPE explicitly and keep the
// runtime value import for createTransport().
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { getAppUrl } from "@/lib/app-url";

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

interface EmailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  fromName: string;
}

function getEmailConfig(): EmailConfig | null {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;
  return {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT) || 587,
    user,
    pass,
    from: process.env.SMTP_FROM || user,
    fromName: process.env.SMTP_FROM_NAME || "Nexus Gate",
  };
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  const config = getEmailConfig();
  if (!config) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass },
    });
  }
  return transporter;
}

// Check if SMTP is configured (optional - Supabase handles email by default).
export function isEmailConfigured(): boolean {
  return getEmailConfig() !== null;
}

// Optional: send a welcome email after successful verification.
// Non-critical: failures are logged but never block the request.
export async function sendWelcomeEmail(
  to: string,
  fullName: string,
): Promise<void> {
  const config = getEmailConfig();
  if (!config) return;
  const transport = getTransporter();
  if (!transport) return;
  try {
    const appUrl = getAppUrl();
    await transport.sendMail({
      from: `"${config.fromName}" <${config.from}>`,
      to,
      subject: "Welcome to Nexus Gate",
      text: `Hi ${fullName},\n\nYour account is now active. You can sign in at ${appUrl}\n\n - Nexus Gate Team`,
      html: `
        <div style="font-family: 'Roboto Mono', ui-monospace, monospace; max-width: 480px; margin: 0 auto; padding: 24px; background: #fffef7; border-radius: 12px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <h1 style="font-family: 'JetBrains Mono', monospace; color: #b45309; font-size: 24px; margin: 0;">Nexus Gate</h1>
          </div>
          <h2 style="font-family: 'JetBrains Mono', monospace; color: #1f2937; font-size: 20px;">Welcome, ${escapeHtml(fullName)}!</h2>
          <p style="color: #4b5563; font-size: 15px; line-height: 1.5;">
            Your account is now active. You can sign in and start checking in to your classes.
          </p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${escapeHtml(appUrl)}" style="display: inline-block; background: #b45309; color: #fff; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600;">
              Sign in
            </a>
          </div>
        </div>
      `,
    });
  } catch {
    // Non-critical.
  }
}

// ====================================================================
// Infrastructure alerts (dependency keep-alive watchdog)
// --------------------------------------------------------------------
// Unlike the user-facing sends above, this one is CRITICAL-priority:
// it is the only channel that reaches admins while Supabase Auth is
// down (in-app notifications require a login, which is exactly what is
// broken). See docs/supabase-keep-alive.md.
//
// THROWS on any failure (unconfigured SMTP, transport error) so the
// caller (src/lib/keep-alive.ts) can leave the dedupe anchor untouched
// and retry delivery on the next run instead of marking it delivered.
// ====================================================================
export async function sendInfraAlertEmail(input: {
  to: string[];
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const config = getEmailConfig();
  if (!config) {
    throw new Error(
      "SMTP is not configured (SMTP_USER/SMTP_PASS) - infra alert cannot be " +
        "delivered. Set the SMTP_* env vars so auth-outage alerts reach the " +
        "admins (docs/supabase-keep-alive.md §5).",
    );
  }
  const transport = getTransporter();
  if (!transport) throw new Error("SMTP transporter unavailable");
  await transport.sendMail({
    from: `"${config.fromName}" <${config.from}>`,
    to: input.to.join(", "),
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
}
