import { simpleParser } from "mailparser";

/** Single address record from a parsed email. */
export interface ParsedAddress {
  address?: string;
  name?: string;
}

/** Address-list field as returned by mailparser (from / to / cc / bcc). */
export interface ParsedAddressList {
  value?: ParsedAddress[];
  text?: string;
}

/**
 * Narrow shape of mailparser's `ParsedMail` that the wrapper reads.
 * Mailparser's full output is much wider (attachments, headers map,
 * raw, html-as-text, …) — we only read the fields below.
 */
export interface ParsedMailLike {
  subject?: string;
  from?: ParsedAddressList;
  to?: ParsedAddressList;
  text?: string;
  /** mailparser may return `false` for missing html; widened for that. */
  html?: string | false;
  messageId?: string;
  inReplyTo?: string;
  /** Space-separated string or array of Message-IDs. */
  references?: string | string[];
  date?: Date;
}

/**
 * Async parser function. Wrapping mailparser's `simpleParser` lets
 * tests inject deterministic synthetic outputs.
 */
export type ParseFn = (source: Buffer | string) => Promise<ParsedMailLike>;

/** Default parser — calls `mailparser.simpleParser` and casts. */
export const defaultParser: ParseFn = async (source) => {
  // mailparser's runtime output is structurally compatible with
  // ParsedMailLike for the fields we read; cast at the boundary.
  return (await simpleParser(source)) as unknown as ParsedMailLike;
};
