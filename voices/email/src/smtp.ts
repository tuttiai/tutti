import nodemailer from "nodemailer";

/** Arguments accepted by {@link SmtpTransporterLike.sendMail}. */
export interface SmtpSendArgs {
  from: string;
  to: string | string[];
  subject: string;
  text: string;
  /** Optional HTML body. Most agent replies are plain text. */
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  /** RFC 5322 In-Reply-To header — the Message-ID being replied to. */
  inReplyTo?: string;
  /**
   * RFC 5322 References header — the chain of Message-IDs in the
   * thread. Either a single string of space-separated IDs or an array
   * (nodemailer accepts both).
   */
  references?: string | string[];
  /** Extra headers passed straight through to nodemailer. */
  headers?: Record<string, string>;
}

/** Subset of nodemailer's `SentMessageInfo` we surface back. */
export interface SmtpSendInfo {
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
  response?: string;
}

/**
 * Minimal shape of nodemailer's transporter that the wrapper drives.
 * Declared explicitly so tests can inject mocks without instantiating
 * a real transporter — which would open a TCP connection on first
 * sendMail.
 */
export interface SmtpTransporterLike {
  sendMail(args: SmtpSendArgs): Promise<SmtpSendInfo>;
  /** Optional — pooled transports use it; real-time transports may not. */
  close?(): unknown;
}

/** Connection options accepted by both the wrapper and the factory. */
export interface SmtpConnectOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** TLS preference. Default false for ports 25/587 (STARTTLS), true for 465. */
  secure?: boolean;
}

/** Synchronous factory; swappable in tests. */
export type SmtpFactory = (options: SmtpConnectOptions) => SmtpTransporterLike;

/**
 * Default factory — calls `nodemailer.createTransport` with the
 * supplied auth. Cast through `unknown` at the boundary.
 */
export function defaultSmtpFactory(options: SmtpConnectOptions): SmtpTransporterLike {
  return nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure ?? options.port === 465,
    auth: { user: options.user, pass: options.pass },
  }) as unknown as SmtpTransporterLike;
}
