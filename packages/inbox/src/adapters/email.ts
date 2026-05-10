// Type-only import — does not require @tuttiai/email to be installed
// at compile time. The runtime import below performs the lazy load;
// consumers that don't use the email adapter never trigger it.
import type {
  EmailClientWrapper,
  EmailMessage,
  ImapFactory,
  ParseFn,
  SmtpFactory,
} from "@tuttiai/email";
import { SecretsManager } from "@tuttiai/core";
import type { InboxAdapter, InboxMessage, InboxMessageHandler, InboxReply } from "../types.js";

export interface EmailInboxAdapterOptions {
  imap: { host: string; port: number; user: string; password?: string; secure?: boolean };
  smtp: { host: string; port: number; user: string; password?: string; secure?: boolean };
  /** Default From header on outbound replies. */
  from: string;
  /** Char limit on inbound text body. Default 1_000_000. */
  maxBodyChars?: number;
  /** Run SecretsManager.redact on dispatched text. Default true. */
  inboxRedactRawText?: boolean;
  /** Test-only — inject a mock IMAP factory. */
  imapFactory?: ImapFactory;
  /** Test-only — inject a mock SMTP factory. */
  smtpFactory?: SmtpFactory;
  /** Test-only — inject a deterministic mailparser. */
  parser?: ParseFn;
}

/**
 * Threading context cached per inbound message id. The inbox stores
 * one entry on receive and looks it up on `send` so the orchestrator's
 * reply lands in the right thread without needing the agent to manage
 * Message-IDs.
 */
interface ThreadEntry {
  messageId: string;
  references: string[];
  fromAddress: string;
  subject: string;
}

/** Default LRU cap on the in-memory threading map. */
export const DEFAULT_THREAD_CACHE_SIZE = 1_000;

/**
 * Bounded insertion-order LRU. JS Maps preserve insertion order, so a
 * `delete + set` on an existing key promotes it to the most-recent
 * end; the oldest is whatever `keys().next()` yields.
 */
class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly maxSize: number) {}
  get(key: K): V | undefined {
    return this.map.get(key);
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      const first = this.map.keys().next();
      if (first.done === true) break;
      this.map.delete(first.value);
    }
  }
  get size(): number {
    return this.map.size;
  }
}

/**
 * Inbox adapter for email. Dynamic-imports `@tuttiai/email` so the
 * package is an OPTIONAL peer dependency — consumers that don't use
 * the email adapter don't need to install it (or its imapflow /
 * nodemailer / mailparser transitive tree).
 *
 * Key behaviours:
 * - Each inbound email becomes its own `platform_chat_id` (= the
 *   Message-ID). Cross-message session continuity flows through
 *   `platform_user_id` (= sender address) and the inbox's identity
 *   store, NOT the chat_id.
 * - On receive, the adapter caches the threading context (Message-ID,
 *   References, from, subject) keyed by chat_id; `send` looks it up to
 *   build a properly-threaded reply with `In-Reply-To` and `References`.
 * - The cache is bounded by an insertion-order LRU (default 1000
 *   entries) so a long-running bot doesn't grow unbounded.
 * - Inbound text is prefixed with `Subject: …\n\n` before being handed
 *   to the orchestrator — agents see the subject as part of the
 *   conversation context.
 */
export class EmailInboxAdapter implements InboxAdapter {
  readonly platform = "email" as const;
  private wrapper?: EmailClientWrapper;
  private unsubscribe?: () => void;
  private started = false;
  private readonly threads: BoundedMap<string, ThreadEntry>;

  constructor(
    private readonly options: EmailInboxAdapterOptions,
    threadCacheSize: number = DEFAULT_THREAD_CACHE_SIZE,
  ) {
    this.threads = new BoundedMap<string, ThreadEntry>(threadCacheSize);
  }

  async start(handler: InboxMessageHandler): Promise<void> {
    if (this.started) return;

    const imapPass =
      this.options.imap.password ??
      SecretsManager.optional("TUTTI_EMAIL_IMAP_PASSWORD") ??
      SecretsManager.optional("TUTTI_EMAIL_PASSWORD");
    if (!imapPass) {
      throw new Error(
        "EmailInboxAdapter: IMAP password missing. Set TUTTI_EMAIL_IMAP_PASSWORD (or TUTTI_EMAIL_PASSWORD if shared with SMTP) before starting the inbox.",
      );
    }
    const smtpPass =
      this.options.smtp.password ??
      SecretsManager.optional("TUTTI_EMAIL_SMTP_PASSWORD") ??
      SecretsManager.optional("TUTTI_EMAIL_PASSWORD");
    if (!smtpPass) {
      throw new Error(
        "EmailInboxAdapter: SMTP password missing. Set TUTTI_EMAIL_SMTP_PASSWORD (or TUTTI_EMAIL_PASSWORD if shared) before starting the inbox.",
      );
    }

    const mod = await loadEmailModule();
    const wrapperOptions = this.buildWrapperOptions(imapPass, smtpPass);
    const key = mod.EmailClientWrapper.keyFor({ imap: this.options.imap });
    this.wrapper = mod.EmailClientWrapper.forKey(key, wrapperOptions);

    this.unsubscribe = this.wrapper.subscribeMessage(async (msg) => {
      const im = this.toInboxMessage(msg);
      if (!im) return;
      try {
        await handler(im);
      } catch {
        // Defensive — orchestrator's onInbound never throws by contract.
      }
    });
    await this.wrapper.whenSubscribed();
    this.started = true;
  }

  private buildWrapperOptions(
    imapPass: string,
    smtpPass: string,
  ): import("@tuttiai/email").EmailClientWrapperOptions {
    const o: import("@tuttiai/email").EmailClientWrapperOptions = {
      imap: {
        host: this.options.imap.host,
        port: this.options.imap.port,
        user: this.options.imap.user,
        pass: imapPass,
        ...(this.options.imap.secure !== undefined ? { secure: this.options.imap.secure } : {}),
      },
      smtp: {
        host: this.options.smtp.host,
        port: this.options.smtp.port,
        user: this.options.smtp.user,
        pass: smtpPass,
        ...(this.options.smtp.secure !== undefined ? { secure: this.options.smtp.secure } : {}),
      },
      from: this.options.from,
    };
    if (this.options.imapFactory !== undefined) o.imapFactory = this.options.imapFactory;
    if (this.options.smtpFactory !== undefined) o.smtpFactory = this.options.smtpFactory;
    if (this.options.parser !== undefined) o.parser = this.options.parser;
    if (this.options.maxBodyChars !== undefined) o.maxBodyChars = this.options.maxBodyChars;
    if (this.options.inboxRedactRawText !== undefined) {
      o.redactRawText = this.options.inboxRedactRawText;
    }
    return o;
  }

  /**
   * Build the orchestrator-facing message and side-effect the
   * threading cache. Returns null when the wrapper handed us a message
   * with neither subject nor body — those carry no useful agent input.
   */
  private toInboxMessage(msg: EmailMessage): InboxMessage | null {
    const subject = msg.subject.trim();
    const body = msg.text.trim();
    if (subject.length === 0 && body.length === 0) return null;
    // Prefix Subject so the agent sees it as part of the conversation
    // context. Subsequent messages in the same thread will repeat the
    // subject which is fine — the agent's session memory dedupes it.
    const text = subject.length > 0 ? `Subject: ${msg.subject}\n\n${msg.text}` : msg.text;
    this.threads.set(msg.messageId, {
      messageId: msg.messageId,
      references: msg.references,
      fromAddress: msg.from.address,
      subject: msg.subject,
    });
    const im: InboxMessage = {
      platform: "email",
      platform_user_id: msg.from.address,
      platform_chat_id: msg.messageId,
      text,
      timestamp: msg.date ? msg.date.getTime() : Date.now(),
      raw: msg,
    };
    return im;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.wrapper) {
      await this.wrapper.destroy();
      this.wrapper = undefined;
    }
    this.started = false;
  }

  async send(chat_id: string, reply: InboxReply): Promise<void> {
    if (!this.wrapper) {
      throw new Error("EmailInboxAdapter.send called before start().");
    }
    if (reply.text.length === 0) return;
    const entry = this.threads.get(chat_id);
    if (!entry) {
      throw new Error(
        `EmailInboxAdapter.send: no threading context for chat_id ${chat_id}. The inbox can only reply to messages it received itself; for fresh sends use the email voice's send_email tool.`,
      );
    }
    const subject = entry.subject.startsWith("Re:") ? entry.subject : `Re: ${entry.subject}`;
    // References = existing chain + the message we're replying to
    // (entry.messageId), avoiding duplicate inclusion.
    const references = entry.references.includes(entry.messageId)
      ? entry.references
      : [...entry.references, entry.messageId];
    await this.wrapper.send({
      to: entry.fromAddress,
      subject,
      text: reply.text,
      inReplyTo: entry.messageId,
      references,
    });
  }

  /** For tests and diagnostics. */
  get _threadCacheSize(): number {
    return this.threads.size;
  }
}

let cachedModule: typeof import("@tuttiai/email") | undefined;

async function loadEmailModule(): Promise<typeof import("@tuttiai/email")> {
  if (cachedModule) return cachedModule;
  try {
    cachedModule = await import("@tuttiai/email");
    return cachedModule;
  } catch (err) {
    throw new Error(
      "EmailInboxAdapter: @tuttiai/email is not installed. Run `npm install @tuttiai/email` (or `tutti-ai add email`) and try again. " +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
