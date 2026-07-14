/**
 * Pluggable email sender for delivering the email-OTP second factor.
 *
 * The OTP plaintext is NEVER persisted or logged — it is used only to
 * compose the transient email body and is discarded after the send call.
 *
 * @module lib/email
 * Requirements: 1.4
 */

import { Resend } from "resend";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Pluggable interface for sending OTP emails. Implementations must guarantee
 * that the OTP plaintext is not persisted or logged.
 */
export interface EmailSender {
  /**
   * Deliver a one-time passcode to the given email address.
   *
   * @param to  - Recipient email address.
   * @param otp - The 6-digit OTP code (plaintext). Must NOT be logged or stored.
   */
  sendOtp(to: string, otp: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Production implementation — Resend
// ---------------------------------------------------------------------------

export interface ResendEmailSenderOptions {
  /** Resend API key. Defaults to the RESEND_API_KEY environment variable. */
  apiKey?: string;
  /** Sender address shown in the "From" field. */
  from?: string;
}

/**
 * Sends OTP emails via the Resend transactional email service.
 *
 * The OTP plaintext is embedded only in the transient email body passed to the
 * Resend API and is never written to any log, file, or data store.
 */
export class ResendEmailSender implements EmailSender {
  private readonly client: Resend;
  private readonly from: string;

  constructor(options: ResendEmailSenderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ResendEmailSender: missing Resend API key. " +
          "Set the RESEND_API_KEY environment variable or pass apiKey in options."
      );
    }
    this.client = new Resend(apiKey);
    this.from = options.from ?? "PDM Portal <noreply@premiumdownloadmanager.com>";
  }

  async sendOtp(to: string, otp: string): Promise<void> {
    const { error } = await this.client.emails.send({
      from: this.from,
      to,
      subject: "Your PDM Portal verification code",
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #1a1a1a;">Verification Code</h2>
          <p style="font-size: 14px; color: #333;">
            Use the code below to complete your sign-in to the PDM Admin Portal.
            This code expires in 10 minutes.
          </p>
          <p style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #111; margin: 24px 0;">
            ${otp}
          </p>
          <p style="font-size: 12px; color: #666;">
            If you did not request this code, you can safely ignore this email.
          </p>
        </div>
      `.trim(),
      text: `Your PDM Portal verification code is: ${otp}\n\nThis code expires in 10 minutes. If you did not request this code, ignore this email.`,
    });

    if (error) {
      throw new Error(`ResendEmailSender: failed to send OTP email — ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Test fake — captures sent messages without actually sending
// ---------------------------------------------------------------------------

export interface SentOtpMessage {
  to: string;
  otp: string;
  sentAt: Date;
}

/**
 * In-memory fake email sender for tests. Captures every `sendOtp` invocation
 * so tests can assert on delivery without hitting a real mail service.
 */
export class FakeEmailSender implements EmailSender {
  /** All OTP messages "sent" during the test. */
  readonly sent: SentOtpMessage[] = [];

  async sendOtp(to: string, otp: string): Promise<void> {
    this.sent.push({ to, otp, sentAt: new Date() });
  }

  /** Reset the captured messages (convenience for test teardown). */
  clear(): void {
    this.sent.length = 0;
  }

  /** Return the most recently sent message, or undefined. */
  lastMessage(): SentOtpMessage | undefined {
    return this.sent[this.sent.length - 1];
  }
}
