import { SecretsManager } from "@tuttiai/core";
import {
  defaultImapFactory,
  type ImapClientLike,
  type ImapConnectOptions,
  type ImapFactory,
  type ImapMessage,
} from "./imap.js";
import {
  defaultSmtpFactory,
  type SmtpConnectOptions,
  type SmtpFactory,
  type SmtpSendArgs,
  type SmtpSendInfo,
  type SmtpTransporterLike,
} from "./smtp.js";
import { defaultParser, type ParsedMailLike, type ParseFn } from "./parser.js";

/** Default char limit on inbound message bodies. ~1 MB; configurable. */
export const DEFAULT_MAX_BODY_CHARS = 1_000_000;

/** Inbound message in the canonical shape the wrapper hands to subscribers. */
export interface EmailMessage {
  /** IMAP UID — stable for the message's life on the server. */
  uid: number;
  /** RFC 5322 Message-ID with surrounding angle brackets. */
  messageId: string;
  /** Direct parent in the thread, if any. */
  inReplyTo?: string;
  /** RFC 5322 References chain (oldest first), already parsed into IDs. */
  references: string[];
  /** Sender — always present; messages without a parseable from are dropped. */
  from: { address: string; name?: string };
  subject: string;
  /** Plain-text body. Already redacted via {@link SecretsManager.redact} unless `redactRawText: false`. */
  text: string;
  date?: Date;
}

/** Handler invoked for every accepted inbound message. */
export type EmailMessageHandler = (msg: EmailMessage) => void | Promise<void>;

/** Single entry returned by {@link EmailClientWrapper.listMessages}. */
export interface EmailListEntry {
  uid: number;
  messageId?: string;
  from?: { address?: string; name?: string };
  subject?: string;
  date?: Date;
  unread: boolean;
}

/** Send arguments accepted by {@link EmailClientWrapper.send}. */
export interface EmailSendArgs {
  to: string | string[];
  subject: string;
  text: string;
  cc?: string | string[];
  bcc?: string | string[];
  /** Message-ID being replied to. Sets the In-Reply-To header. */
  inReplyTo?: string;
  /** Thread chain. Either a string of space-separated IDs or an array. */
  references?: string | string[];
  html?: string;
}

/** Constructor / forKey options for {@link EmailClientWrapper}. */
export interface EmailClientWrapperOptions {
  imap: ImapConnectOptions;
  smtp: SmtpConnectOptions;
  /** Default From header on outbound mail. e.g. "Tutti Bot <bot@example.com>". */
  from: string;
  imapFactory?: ImapFactory;
  smtpFactory?: SmtpFactory;
  parser?: ParseFn;
  /** Char limit on inbound text body. Default {@link DEFAULT_MAX_BODY_CHARS}. */
  maxBodyChars?: number;
  /** Run `SecretsManager.redact` on dispatched text. Default `true`. */
  redactRawText?: boolean;
}

/**
 * Wrapper around an IMAP IDLE connection (inbound) + a nodemailer
 * SMTP transporter (outbound). The IMAP connection stays open for the
 * wrapper's lifetime and pushes new mail via the `exists` event;
 * SMTP is created lazily on first send.
 *
 * Construction modes mirror the other voices:
 * - {@link forKey} (preferred) — keyed shared instance with reference
 *   counting. The key is `${imap.host}:${imap.port}:${imap.user}`,
 *   computed via {@link keyFor}. Multiple callers (the voice's
 *   outbound tools and `@tuttiai/inbox`'s email adapter) share one
 *   IMAP connection.
 * - `new EmailClientWrapper(options)` — standalone (not cached).
 */
export class EmailClientWrapper {
  static readonly cache = new Map<string, EmailClientWrapper>();

  static keyFor(opts: { imap: { host: string; port: number; user: string } }): string {
    return `${opts.imap.host}:${opts.imap.port}:${opts.imap.user}`;
  }

  static forKey(key: string, options: EmailClientWrapperOptions): EmailClientWrapper {
    const existing = this.cache.get(key);
    if (existing) {
      existing.refCount += 1;
      return existing;
    }
    const wrapper = new EmailClientWrapper(options);
    wrapper.cacheKey = key;
    wrapper.refCount = 1;
    this.cache.set(key, wrapper);
    return wrapper;
  }

  private imap?: ImapClientLike;
  private smtp?: SmtpTransporterLike;
  private imapConnectPromise?: Promise<ImapClientLike>;
  private mailboxOpened = false;
  private readonly subscribers = new Set<EmailMessageHandler>();
  private dispatcherInstalled = false;
  private dispatcherInstallPromise?: Promise<void>;
  private cacheKey?: string;
  private refCount = 0;
  private destroyed = false;

  constructor(private readonly options: EmailClientWrapperOptions) {}

  // ── inbound ────────────────────────────────────────────────────────

  /** Subscribe to inbound messages. Eagerly opens IMAP + IDLE; idempotent. */
  subscribeMessage(handler: EmailMessageHandler): () => void {
    this.subscribers.add(handler);
    void this.installDispatcher();
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /** Resolves once IMAP IDLE is wired up — for callers that need to await readiness. */
  whenSubscribed(): Promise<void> {
    if (this.dispatcherInstalled) return Promise.resolve();
    return this.dispatcherInstallPromise ?? Promise.resolve();
  }

  /** Explicit start. Equivalent to subscribeMessage(noop) without registering a handler. */
  async launch(): Promise<void> {
    await this.installDispatcher();
  }

  private installDispatcher(): Promise<void> {
    if (this.dispatcherInstalled) return Promise.resolve();
    if (this.dispatcherInstallPromise) return this.dispatcherInstallPromise;
    this.dispatcherInstallPromise = (async () => {
      const imap = await this.ensureMailboxOpen();
      // Drain any UNSEEN that arrived while we were offline before we
      // start listening — otherwise users who message at start-up wait
      // for the next push that may not come for hours.
      await this.fetchAndDispatch(imap);
      imap.on("exists", () => {
        void this.fetchAndDispatch(imap).catch(() => {
          // Per-message errors are handled inside fetchAndDispatch;
          // a top-level reject here would only come from a hard IMAP
          // failure — non-fatal at this layer.
        });
      });
      this.dispatcherInstalled = true;
    })();
    return this.dispatcherInstallPromise.catch((err) => {
      this.dispatcherInstallPromise = undefined;
      throw err;
    });
  }

  private async fetchAndDispatch(imap: ImapClientLike): Promise<void> {
    const parser = this.options.parser ?? defaultParser;
    const maxChars = this.options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
    const redact = this.options.redactRawText ?? true;
    for await (const raw of imap.fetch(
      { seen: false },
      { source: true, envelope: true, uid: true, size: true },
    )) {
      await this.processOne(imap, raw, parser, maxChars, redact);
    }
  }

  private async processOne(
    imap: ImapClientLike,
    raw: ImapMessage,
    parser: ParseFn,
    maxChars: number,
    redact: boolean,
  ): Promise<void> {
    try {
      // Reject by RFC822 SIZE first — cheap and avoids parsing a giant
      // payload. The factor of 2 leaves headroom for headers + base64
      // encoding overhead vs. the body's char count.
      if (raw.size !== undefined && raw.size > maxChars * 2) {
        await this.markSeen(imap, raw.uid);
        return;
      }
      if (!raw.source) {
        await this.markSeen(imap, raw.uid);
        return;
      }
      const parsed = await parser(raw.source);
      if ((parsed.text?.length ?? 0) > maxChars) {
        await this.markSeen(imap, raw.uid);
        return;
      }
      const msg = parsedToEmailMessage(raw.uid, parsed, redact);
      if (!msg) {
        await this.markSeen(imap, raw.uid);
        return;
      }
      for (const handler of [...this.subscribers]) {
        try {
          await handler(msg);
        } catch {
          // Wrapper is not the place for error reporting — orchestrator
          // emits typed events on its handler's throws.
        }
      }
      await this.markSeen(imap, raw.uid);
    } catch {
      // Always mark seen on per-message failure to avoid an infinite
      // re-fetch loop on a poison message. Best-effort.
      try {
        await this.markSeen(imap, raw.uid);
      } catch {
        // Lost connection — next cycle will retry.
      }
    }
  }

  private markSeen(imap: ImapClientLike, uid: number): Promise<unknown> {
    return imap.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
  }

  // ── outbound ───────────────────────────────────────────────────────

  /** Send an email. Use `inReplyTo` + `references` to thread replies. */
  async send(args: EmailSendArgs): Promise<SmtpSendInfo> {
    const transport = this.getSmtp();
    const sendArgs: SmtpSendArgs = {
      from: this.options.from,
      to: args.to,
      subject: args.subject,
      text: args.text,
      ...(args.cc !== undefined ? { cc: args.cc } : {}),
      ...(args.bcc !== undefined ? { bcc: args.bcc } : {}),
      ...(args.inReplyTo !== undefined ? { inReplyTo: args.inReplyTo } : {}),
      ...(args.references !== undefined ? { references: args.references } : {}),
      ...(args.html !== undefined ? { html: args.html } : {}),
    };
    return transport.sendMail(sendArgs);
  }

  /** List recent messages — read-only summary for tools. */
  async listMessages(args: {
    limit?: number;
    unseenOnly?: boolean;
    since?: Date;
  } = {}): Promise<EmailListEntry[]> {
    const imap = await this.ensureMailboxOpen();
    const filter: { seen?: boolean; since?: Date } = {};
    if (args.unseenOnly) filter.seen = false;
    if (args.since) filter.since = args.since;
    const limit = args.limit ?? 10;
    const out: EmailListEntry[] = [];
    let count = 0;
    for await (const msg of imap.fetch(filter, { envelope: true, uid: true })) {
      if (count >= limit) break;
      count++;
      const entry: EmailListEntry = { uid: msg.uid, unread: filter.seen === false };
      if (msg.envelope?.messageId) entry.messageId = msg.envelope.messageId;
      const sender = msg.envelope?.from?.[0];
      if (sender) {
        const f: EmailListEntry["from"] = {};
        if (sender.address !== undefined) f.address = sender.address;
        if (sender.name !== undefined) f.name = sender.name;
        entry.from = f;
      }
      if (msg.envelope?.subject) entry.subject = msg.envelope.subject;
      if (msg.envelope?.date) entry.date = msg.envelope.date;
      out.push(entry);
    }
    return out;
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    if (this.cacheKey !== undefined) {
      this.refCount -= 1;
      if (this.refCount > 0) return;
      EmailClientWrapper.cache.delete(this.cacheKey);
    }
    this.destroyed = true;
    this.subscribers.clear();
    if (this.imap) {
      try {
        await this.imap.logout();
      } catch {
        // best-effort
      }
    }
    if (this.smtp?.close) {
      try {
        await this.smtp.close();
      } catch {
        // best-effort
      }
    }
    this.imap = undefined;
    this.smtp = undefined;
    this.imapConnectPromise = undefined;
    this.mailboxOpened = false;
    this.dispatcherInstalled = false;
    this.dispatcherInstallPromise = undefined;
  }

  /** For tests and diagnostics — current shared-cache ref count. */
  get _refCount(): number {
    return this.refCount;
  }

  /** For tests — has IDLE been wired up? */
  get _dispatcherInstalled(): boolean {
    return this.dispatcherInstalled;
  }

  // ── connection helpers ─────────────────────────────────────────────

  private async getImap(): Promise<ImapClientLike> {
    if (this.imap) return this.imap;
    if (this.imapConnectPromise) return this.imapConnectPromise;
    this.imapConnectPromise = (async () => {
      const factory = this.options.imapFactory ?? defaultImapFactory;
      const c = factory(this.options.imap);
      await c.connect();
      this.imap = c;
      return c;
    })();
    try {
      return await this.imapConnectPromise;
    } catch (err) {
      this.imapConnectPromise = undefined;
      throw err;
    }
  }

  private async ensureMailboxOpen(): Promise<ImapClientLike> {
    const imap = await this.getImap();
    if (!this.mailboxOpened) {
      await imap.mailboxOpen("INBOX");
      this.mailboxOpened = true;
    }
    return imap;
  }

  private getSmtp(): SmtpTransporterLike {
    if (this.smtp) return this.smtp;
    const factory = this.options.smtpFactory ?? defaultSmtpFactory;
    this.smtp = factory(this.options.smtp);
    return this.smtp;
  }
}

/**
 * Translate a parsed mailparser output into the canonical
 * {@link EmailMessage} shape. Returns null when the message lacks an
 * identifiable sender or Message-ID — those are dropped at the wrapper
 * boundary and marked Seen so they don't replay forever.
 */
export function parsedToEmailMessage(
  uid: number,
  parsed: ParsedMailLike,
  redact: boolean,
): EmailMessage | null {
  const fromAddress = parsed.from?.value?.[0]?.address;
  if (!fromAddress) return null;
  const messageId = parsed.messageId ?? "";
  if (!messageId) return null;
  const subject = parsed.subject ?? "";
  let text = parsed.text ?? "";
  if (redact) text = SecretsManager.redact(text);
  const refs = Array.isArray(parsed.references)
    ? parsed.references
    : typeof parsed.references === "string"
      ? parsed.references.split(/\s+/).filter(Boolean)
      : [];
  const out: EmailMessage = {
    uid,
    messageId,
    references: refs,
    from: { address: fromAddress },
    subject,
    text,
  };
  if (parsed.inReplyTo) out.inReplyTo = parsed.inReplyTo;
  const senderName = parsed.from?.value?.[0]?.name;
  if (senderName) out.from.name = senderName;
  if (parsed.date) out.date = parsed.date;
  return out;
}
