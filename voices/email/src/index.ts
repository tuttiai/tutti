import type { Permission, Tool, Voice } from "@tuttiai/types";
import { SecretsManager } from "@tuttiai/core";
import {
  EmailClientWrapper,
  type EmailClientWrapperOptions,
} from "./client.js";
import type { ImapFactory } from "./imap.js";
import type { SmtpFactory } from "./smtp.js";
import type { ParseFn } from "./parser.js";
import { createSendEmailTool } from "./tools/send-email.js";
import { createSendReplyTool } from "./tools/send-reply.js";
import { createListInboxTool } from "./tools/list-inbox.js";

/** Score-side options for {@link createEmailClient} / {@link EmailVoice}. */
export interface EmailClientOptions {
  imap: {
    host: string;
    port: number;
    user: string;
    /** Password. Falls back to `TUTTI_EMAIL_IMAP_PASSWORD` then `TUTTI_EMAIL_PASSWORD`. */
    password?: string;
    /** TLS preference. Default `true` (matches port 993). */
    secure?: boolean;
  };
  smtp: {
    host: string;
    port: number;
    user: string;
    /** Password. Falls back to `TUTTI_EMAIL_SMTP_PASSWORD` then `TUTTI_EMAIL_PASSWORD`. */
    password?: string;
    /** TLS preference. Default depends on port (465 = true, 587/25 = false → STARTTLS). */
    secure?: boolean;
  };
  /** Default From header on outbound mail. e.g. "Tutti Bot <bot@example.com>". */
  from: string;
  /** Char limit on inbound text body. Default 1_000_000 (~1 MB). */
  maxBodyChars?: number;
  /** Run `SecretsManager.redact` on dispatched text. Default `true`. */
  redactRawText?: boolean;
  /** Test-only — inject a mock IMAP factory. */
  imapFactory?: ImapFactory;
  /** Test-only — inject a mock SMTP factory. */
  smtpFactory?: SmtpFactory;
  /** Test-only — inject a deterministic mailparser. */
  parser?: ParseFn;
}

/**
 * Resolved client state — either usable or an explanatory "missing"
 * placeholder. Tools never throw on missing auth; they hand the
 * message back as a ToolResult via `guardClient`.
 */
export type EmailClient =
  | { kind: "ready"; wrapper: EmailClientWrapper }
  | { kind: "missing"; message: string };

/**
 * Resolve credentials from options then env. Never throws — returns
 * `kind: "missing"` when a password is unset so individual tool calls
 * surface the same helpful message without crashing the voice at
 * construction time. Passwords are read via `SecretsManager.optional`
 * so the SecretsManager redaction list catches them in logs and event
 * payloads.
 */
export function createEmailClient(options: EmailClientOptions): EmailClient {
  const sharedPass = SecretsManager.optional("TUTTI_EMAIL_PASSWORD");
  const imapPass =
    options.imap.password ?? SecretsManager.optional("TUTTI_EMAIL_IMAP_PASSWORD") ?? sharedPass;
  const smtpPass =
    options.smtp.password ?? SecretsManager.optional("TUTTI_EMAIL_SMTP_PASSWORD") ?? sharedPass;
  if (!imapPass) {
    return {
      kind: "missing",
      message:
        "Email voice IMAP password missing. Set TUTTI_EMAIL_IMAP_PASSWORD (or TUTTI_EMAIL_PASSWORD if shared with SMTP). For Gmail / Outlook with 2FA, generate an app-specific password — basic auth is disabled on most consumer providers as of 2022.",
    };
  }
  if (!smtpPass) {
    return {
      kind: "missing",
      message:
        "Email voice SMTP password missing. Set TUTTI_EMAIL_SMTP_PASSWORD (or TUTTI_EMAIL_PASSWORD if shared with IMAP) so the bot can deliver outbound mail.",
    };
  }
  const wrapperOptions: EmailClientWrapperOptions = {
    imap: {
      host: options.imap.host,
      port: options.imap.port,
      user: options.imap.user,
      pass: imapPass,
      ...(options.imap.secure !== undefined ? { secure: options.imap.secure } : {}),
    },
    smtp: {
      host: options.smtp.host,
      port: options.smtp.port,
      user: options.smtp.user,
      pass: smtpPass,
      ...(options.smtp.secure !== undefined ? { secure: options.smtp.secure } : {}),
    },
    from: options.from,
    ...(options.imapFactory !== undefined ? { imapFactory: options.imapFactory } : {}),
    ...(options.smtpFactory !== undefined ? { smtpFactory: options.smtpFactory } : {}),
    ...(options.parser !== undefined ? { parser: options.parser } : {}),
    ...(options.maxBodyChars !== undefined ? { maxBodyChars: options.maxBodyChars } : {}),
    ...(options.redactRawText !== undefined ? { redactRawText: options.redactRawText } : {}),
  };
  const key = EmailClientWrapper.keyFor({ imap: options.imap });
  return {
    kind: "ready",
    wrapper: EmailClientWrapper.forKey(key, wrapperOptions),
  };
}

/** Options for {@link EmailVoice}. */
export type EmailVoiceOptions = EmailClientOptions;

/**
 * Gives agents the ability to read and send email via IMAP IDLE
 * (inbound) and SMTP (outbound). Three tools: `send_email` and
 * `send_reply` are marked `destructive: true`; `list_inbox` is
 * read-only.
 *
 * The underlying `EmailClientWrapper` is shared via
 * {@link EmailClientWrapper.forKey} (keyed by `host:port:user`), so a
 * score that uses both `@tuttiai/email` (outbound tools) and
 * `@tuttiai/inbox` (inbound) opens one IMAP IDLE connection and one
 * SMTP transporter total.
 */
export class EmailVoice implements Voice {
  name = "email";
  description = "Read and send email via IMAP IDLE + SMTP";
  required_permissions: Permission[] = ["network"];
  tools: Tool[];

  private readonly client: EmailClient;

  constructor(options: EmailVoiceOptions) {
    this.client = createEmailClient(options);
    this.tools = [
      createSendEmailTool(this.client),
      createSendReplyTool(this.client),
      createListInboxTool(this.client),
    ];
  }

  async teardown(): Promise<void> {
    if (this.client.kind === "ready") {
      await this.client.wrapper.destroy();
    }
  }
}

export { EmailClientWrapper, parsedToEmailMessage, DEFAULT_MAX_BODY_CHARS } from "./client.js";
export type {
  EmailClientWrapperOptions,
  EmailMessage,
  EmailMessageHandler,
  EmailListEntry,
  EmailSendArgs,
} from "./client.js";
export type {
  ImapAddress,
  ImapEnvelope,
  ImapMessage,
  ImapClientLike,
  ImapConnectOptions,
  ImapFactory,
  ImapFetchRange,
  ImapFetchOptions,
} from "./imap.js";
export type {
  SmtpSendArgs,
  SmtpSendInfo,
  SmtpTransporterLike,
  SmtpConnectOptions,
  SmtpFactory,
} from "./smtp.js";
export type {
  ParsedAddress,
  ParsedAddressList,
  ParsedMailLike,
  ParseFn,
} from "./parser.js";
