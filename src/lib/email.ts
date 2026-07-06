// ====================================================================
// Nexus Gate — Email Service (Gmail SMTP)
//
// Uses Google SMTP with an App Password (not your regular password).
// Set up: Google Account → Security → 2-Step Verification → App passwords
// Generate a new app password for "Mail" and use it as SMTP_PASS.
//
// Free tier: 500 emails/day per Google account.
// For higher volume, use Google Workspace (2 billion/day).
// ====================================================================

import nodemailer from "nodemailer";
import { getAppUrl } from "@/lib/app-url";

// ---- HTML escaping for user-supplied content in emails (XSS defense) ----
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
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

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  const config = getEmailConfig();
  if (!config) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: {
        user: config.user,
        pass: config.pass,
      },
    });
  }
  return transporter;
}

// ---- Check if email is configured ----
export function isEmailConfigured(): boolean {
  return getEmailConfig() !== null;
}

// ---- Send verification code email ----
export async function sendVerificationEmail(
  to: string,
  code: string
): Promise<{ ok: boolean; error?: string }> {
  const config = getEmailConfig();
  if (!config) {
    return { ok: false, error: "Email not configured" };
  }

  const transport = getTransporter();
  if (!transport) {
    return { ok: false, error: "Email transport not available" };
  }

  try {
    await transport.sendMail({
      from: `"${config.fromName}" <${config.from}>`,
      to,
      subject: "Your Nexus Gate verification code",
      text: `Your verification code is: ${code}\n\nThis code expires in 10 minutes.\n\nIf you didn't create an account, you can ignore this email.`,
      html: `
        <div style="font-family: 'Roboto Mono', ui-monospace, monospace; max-width: 480px; margin: 0 auto; padding: 24px; background: #fffef7; border-radius: 12px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <h1 style="font-family: 'JetBrains Mono', monospace; color: #b45309; font-size: 24px; margin: 0;">Nexus Gate</h1>
            <p style="color: #6b7280; font-size: 14px; margin: 4px 0 0;">CTU Danao · College of Technology</p>
          </div>
          <h2 style="font-family: 'JetBrains Mono', monospace; color: #1f2937; font-size: 20px;">Verify your email</h2>
          <p style="color: #4b5563; font-size: 15px; line-height: 1.5;">
            Enter this code to activate your account:
          </p>
          <div style="text-align: center; margin: 24px 0;">
            <div style="display: inline-block; font-family: 'JetBrains Mono', monospace; font-size: 36px; font-weight: bold; letter-spacing: 0.3em; color: #b45309; background: #fef3c7; padding: 16px 32px; border-radius: 8px; border: 2px solid #fcd34d;">
              ${code}
            </div>
          </div>
          <p style="color: #6b7280; font-size: 13px; line-height: 1.5;">
            This code expires in 10 minutes. If you didn't create an account, you can safely ignore this email.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px; text-align: center;">
            Nexus Gate · CTU Danao Campus<br />
            Do not reply to this email.
          </p>
        </div>
      `,
    });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

// ---- Send welcome email (after verification) ----
export async function sendWelcomeEmail(
  to: string,
  fullName: string
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
      text: `Hi ${fullName},\n\nYour account is now active. You can sign in at ${appUrl}\n\nIf you have any questions, contact your teacher or the College of Technology office.\n\n— Nexus Gate Team`,
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
            <a href="${appUrl}" style="display: inline-block; background: #b45309; color: #fff; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600;">
              Sign in
            </a>
          </div>
          <p style="color: #6b7280; font-size: 13px; line-height: 1.5;">
            If you have any questions, contact your teacher or the College of Technology office.
          </p>
        </div>
      `,
    });
  } catch {
    // Non-critical — don't fail the request
  }
}

// ---- Send password reset email ----
// Returns { ok, error? }. If email is not configured, the caller should log
// the reset link to the console as a dev fallback.
export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string
): Promise<{ ok: boolean; error?: string }> {
  const config = getEmailConfig();
  if (!config) {
    return { ok: false, error: "Email not configured" };
  }

  const transport = getTransporter();
  if (!transport) {
    return { ok: false, error: "Email transport not available" };
  }

  try {
    await transport.sendMail({
      from: `"${config.fromName}" <${config.from}>`,
      to,
      subject: "Reset your Nexus Gate password",
      text: `We received a request to reset your Nexus Gate password.\n\nClick the link below to choose a new password. This link expires in 30 minutes.\n\n${resetUrl}\n\nIf you didn't request a password reset, you can safely ignore this email — your password will not be changed.\n\n— Nexus Gate Team`,
      html: `
        <div style="font-family: 'Roboto Mono', ui-monospace, monospace; max-width: 480px; margin: 0 auto; padding: 24px; background: #fffef7; border-radius: 12px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <h1 style="font-family: 'JetBrains Mono', monospace; color: #b45309; font-size: 24px; margin: 0;">Nexus Gate</h1>
          </div>
          <h2 style="font-family: 'JetBrains Mono', monospace; color: #1f2937; font-size: 20px;">Reset your password</h2>
          <p style="color: #4b5563; font-size: 15px; line-height: 1.5;">
            We received a request to reset your password. Click the button below to choose a new one.
          </p>
          <p style="color: #6b7280; font-size: 13px; line-height: 1.5;">
            This link expires in 30 minutes.
          </p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${resetUrl}" style="display: inline-block; background: #b45309; color: #fff; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600;">
              Reset password
            </a>
          </div>
          <p style="color: #6b7280; font-size: 13px; line-height: 1.5;">
            If you didn't request a password reset, you can safely ignore this email — your password will not be changed.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px; text-align: center;">
            Nexus Gate · CTU Danao Campus<br />
            Do not reply to this email.
          </p>
        </div>
      `,
    });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
