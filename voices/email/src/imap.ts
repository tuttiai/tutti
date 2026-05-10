import { ImapFlow } from "imapflow";

/**
 * Narrow shapes of the slice of imapflow's API the wrapper drives.
 * Declared explicitly so tests can inject mocks without instantiating
 * a real ImapFlow — which would attempt a network connection on
 * `connect()`. The real class is structurally compatible with these
 * interfaces; we cast through `unknown` once at the factory boundary.
 */

/** Single address record in an envelope's from/to/cc/bcc list. */
export interface ImapAddress {
  address?: string;
  name?: string;
}

/** RFC 5322 envelope as returned by IMAP `FETCH ENVELOPE`. */
export interface ImapEnvelope {
  date?: Date;
  subject?: string;
  from?: ImapAddress[];
  to?: ImapAddress[];
  messageId?: string;
  inReplyTo?: string;
}

/** Single message yielded by `client.fetch(...)`. */
export interface ImapMessage {
  uid: number;
  size?: number;
  source?: Buffer;
  envelope?: ImapEnvelope;
}

/** Range filter for `fetch` / `messageFlagsAdd`. Subset of imapflow's accepted shapes. */
export interface ImapFetchRange {
  /** Match unread messages when set to false. */
  seen?: boolean;
  /** Match a specific uid (or sequence range) when set. */
  uid?: number | string;
  /** Match messages received after this date. */
  since?: Date;
}

export interface ImapFetchOptions {
  source?: boolean;
  envelope?: boolean;
  uid?: boolean;
  size?: boolean;
}

/**
 * Imapflow event listener. The real client emits at least these events
 * the wrapper relies on:
 * - `exists` — pushed via IMAP IDLE when the mailbox grows.
 * - `error` — connection / protocol errors. Non-fatal at this layer.
 * - `close` — connection closed.
 */
export type ImapEvent = "exists" | "error" | "close" | "mailboxOpen";

/**
 * Minimal shape of {@link ImapFlow} that the wrapper drives.
 * Intentionally permissive on argument types so tests can satisfy it
 * without re-exporting imapflow's full surface.
 */
export interface ImapClientLike {
  connect(): Promise<unknown>;
  mailboxOpen(path: string): Promise<unknown>;
  fetch(
    range: ImapFetchRange,
    options: ImapFetchOptions,
  ): AsyncIterable<ImapMessage>;
  messageFlagsAdd(
    range: number | string | ImapFetchRange,
    flags: string[],
    options?: { uid?: boolean },
  ): Promise<unknown>;
  logout(): Promise<unknown>;
  on(event: ImapEvent, listener: (...args: unknown[]) => void): unknown;
  off?(event: ImapEvent, listener: (...args: unknown[]) => void): unknown;
}

/** Connection options accepted by both the wrapper and the factory. */
export interface ImapConnectOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** TLS preference. Default true (matches port 993). */
  secure?: boolean;
}

/** Synchronous factory; swappable in tests. */
export type ImapFactory = (options: ImapConnectOptions) => ImapClientLike;

/**
 * Default factory — instantiates the real `ImapFlow` from `imapflow`.
 * Cast through `unknown` once at this boundary to avoid leaking the
 * wider API into the wrapper.
 */
export function defaultImapFactory(options: ImapConnectOptions): ImapClientLike {
  return new ImapFlow({
    host: options.host,
    port: options.port,
    secure: options.secure ?? true,
    auth: { user: options.user, pass: options.pass },
    // imapflow logs verbosely by default; quiet by default for the
    // voice. Consumers that want logs can swap the factory.
    logger: false,
  }) as unknown as ImapClientLike;
}
