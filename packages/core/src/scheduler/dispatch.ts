/**
 * Outbound dispatch for scheduled-run results.
 *
 * Companion to {@link ./delivery.ts} — `delivery.ts` is the
 * registration-time voice-presence check called by
 * {@link SchedulerEngine.schedule}; this module performs the actual
 * send when a scheduled run completes successfully.
 *
 * Voice packages (`@tuttiai/slack`, `@tuttiai/discord`, …) are optional
 * peer dependencies — dynamic-imported at delivery time. The shared
 * `forToken` / `forKey` wrapper cache in each voice means we reuse
 * whichever instance the agent's matching voice already initialised
 * during runtime setup. When the cache is cold we construct one on
 * demand and accept a single ref-count "leak" per platform per process
 * — destroying the wrapper here would race with the live voice still
 * holding the ref.
 *
 * Credentials are read from {@link SecretsManager}, mirroring the env-var
 * convention each voice's `createXClient` already documents. The
 * {@link ScheduleDeliveryTarget} carries addressing only — never tokens.
 */

import type { ScheduleDeliveryTarget } from "@tuttiai/types";
import { logger } from "../logger.js";
import { SecretsManager } from "../secrets.js";
import type { DynamicImportFn } from "./delivery.js";

const defaultImport: DynamicImportFn = (spec) => import(spec);

/** Arguments accepted by {@link deliverScheduleResult}. */
export interface DeliverOptions {
  /** Where to send the message. */
  target: ScheduleDeliveryTarget;
  /** The agent's final text output. */
  content: string;
  /** Wire format — `"text"` is the safe default. */
  format?: "text" | "markdown";
  /** Used as the fallback prefix for the email subject default. */
  agentName?: string;
  /** Test injection — overrides the dynamic-import function. */
  importFn?: DynamicImportFn;
}

/**
 * Dispatch a scheduled run's text output to the configured platform.
 *
 * @throws When the matching voice package is not installed (the error
 *   message names the package and install command) OR when the platform
 *   API rejects the send. Callers — i.e. {@link SchedulerEngine.executeRun}
 *   — wrap this call in try/catch and emit `schedule:delivery_failed`
 *   on rejection so a dispatch error never crashes a scheduled run.
 *
 * @example
 * await deliverScheduleResult({
 *   target: { platform: "slack", channel: "#alerts" },
 *   content: "Daily report ready.",
 * });
 */
export async function deliverScheduleResult(opts: DeliverOptions): Promise<void> {
  const importFn = opts.importFn ?? defaultImport;
  const format = opts.format ?? "text";
  switch (opts.target.platform) {
    case "slack":
      return deliverSlack(opts.target, opts.content, importFn);
    case "discord":
      return deliverDiscord(opts.target, opts.content, importFn);
    case "telegram":
      return deliverTelegram(opts.target, opts.content, format, importFn);
    case "email":
      return deliverEmail(opts.target, opts.content, opts.agentName ?? "agent", importFn);
    case "whatsapp":
      return deliverWhatsApp(opts.target, opts.content, format, importFn);
  }
}

/** Human-readable addressing field per platform — used in events. */
export function deliveryTargetSummary(target: ScheduleDeliveryTarget): string {
  switch (target.platform) {
    case "slack":
      return target.channel;
    case "discord":
      return target.channel_id;
    case "telegram":
      return target.chat_id;
    case "email":
      return target.to;
    case "whatsapp":
      return target.phone_number;
  }
}

// Minimal structural typings for the voice module shapes dispatch touches.
// dispatch.ts deliberately does NOT type-import @tuttiai/<voice> packages —
// each voice already imports `SecretsManager` from @tuttiai/core, so a
// reverse type-edge would close the build-graph loop and turbo would
// refuse to order the workspace builds. Runtime is still a dynamic
// `import(spec)` against the real voice module; only the type surface is
// local. The `engine-delivery` integration tests catch drift if a voice's
// wrapper shape ever diverges from these.

interface WrapperCache<W> {
  get(key: string): W | undefined;
}

interface SlackVoice {
  SlackClientWrapper: {
    cache: WrapperCache<SlackWrapper>;
    forToken(token: string): SlackWrapper;
  };
}
interface SlackWrapper {
  getClient(): Promise<{
    chat: { postMessage(args: { channel: string; text: string }): Promise<unknown> };
  }>;
}

interface DiscordVoice {
  DiscordClientWrapper: {
    cache: WrapperCache<DiscordWrapper>;
    forToken(token: string): DiscordWrapper;
  };
}
interface DiscordChannel {
  send(content: string): Promise<unknown>;
}
interface DiscordWrapper {
  getClient(): Promise<{
    channels: { fetch(id: string): Promise<DiscordChannel | null> };
  }>;
}

interface TelegramVoice {
  TelegramClientWrapper: {
    cache: WrapperCache<TelegramWrapper>;
    forToken(token: string): TelegramWrapper;
  };
}
interface TelegramWrapper {
  telegram: {
    sendMessage(
      chatId: string,
      content: string,
      opts?: { parse_mode: "MarkdownV2" },
    ): Promise<unknown>;
  };
}

interface EmailVoice {
  EmailClientWrapper: {
    cache: WrapperCache<EmailWrapper>;
    forKey(key: string, opts: EmailWrapperOptions): EmailWrapper;
    keyFor(opts: { imap: EmailWrapperOptions["imap"] }): string;
  };
}
interface EmailWrapper {
  send(args: { to: string; subject: string; text: string }): Promise<unknown>;
}

interface WhatsAppVoice {
  WhatsAppClientWrapper: {
    cache: WrapperCache<WhatsAppWrapper>;
    keyFor(opts: { phoneNumberId: string }): string;
  };
}
interface WhatsAppWrapper {
  sendText(phoneNumber: string, body: string): Promise<unknown>;
}

async function deliverSlack(
  target: Extract<ScheduleDeliveryTarget, { platform: "slack" }>,
  content: string,
  importFn: DynamicImportFn,
): Promise<void> {
  const mod = await loadVoice<SlackVoice>("@tuttiai/slack", importFn);
  const token = SecretsManager.require("SLACK_BOT_TOKEN");
  const wrapper =
    mod.SlackClientWrapper.cache.get(token) ?? mod.SlackClientWrapper.forToken(token);
  const client = await wrapper.getClient();
  await client.chat.postMessage({ channel: target.channel, text: content });
}

async function deliverDiscord(
  target: Extract<ScheduleDeliveryTarget, { platform: "discord" }>,
  content: string,
  importFn: DynamicImportFn,
): Promise<void> {
  const mod = await loadVoice<DiscordVoice>("@tuttiai/discord", importFn);
  const token = SecretsManager.require("DISCORD_BOT_TOKEN");
  const wrapper =
    mod.DiscordClientWrapper.cache.get(token) ?? mod.DiscordClientWrapper.forToken(token);
  const client = await wrapper.getClient();
  const channel = await client.channels.fetch(target.channel_id);
  if (!channel) {
    throw new Error(`Discord channel "${target.channel_id}" not found or inaccessible to the bot.`);
  }
  await channel.send(content);
}

async function deliverTelegram(
  target: Extract<ScheduleDeliveryTarget, { platform: "telegram" }>,
  content: string,
  format: "text" | "markdown",
  importFn: DynamicImportFn,
): Promise<void> {
  const mod = await loadVoice<TelegramVoice>("@tuttiai/telegram", importFn);
  const token = SecretsManager.require("TELEGRAM_BOT_TOKEN");
  const wrapper =
    mod.TelegramClientWrapper.cache.get(token) ?? mod.TelegramClientWrapper.forToken(token);
  if (format === "markdown") {
    await wrapper.telegram.sendMessage(target.chat_id, content, { parse_mode: "MarkdownV2" });
  } else {
    await wrapper.telegram.sendMessage(target.chat_id, content);
  }
}

async function deliverEmail(
  target: Extract<ScheduleDeliveryTarget, { platform: "email" }>,
  content: string,
  agentName: string,
  importFn: DynamicImportFn,
): Promise<void> {
  const mod = await loadVoice<EmailVoice>("@tuttiai/email", importFn);
  const wrapperOptions = buildEmailOptions();
  const key = mod.EmailClientWrapper.keyFor({ imap: wrapperOptions.imap });
  const wrapper =
    mod.EmailClientWrapper.cache.get(key) ?? mod.EmailClientWrapper.forKey(key, wrapperOptions);
  const subject = target.subject ?? `${agentName} run — ${new Date().toISOString()}`;
  await wrapper.send({ to: target.to, subject, text: content });
}

async function deliverWhatsApp(
  target: Extract<ScheduleDeliveryTarget, { platform: "whatsapp" }>,
  content: string,
  format: "text" | "markdown",
  importFn: DynamicImportFn,
): Promise<void> {
  const mod = await loadVoice<WhatsAppVoice>("@tuttiai/whatsapp", importFn);
  const phoneNumberId = SecretsManager.require("WHATSAPP_PHONE_NUMBER_ID");
  const key = mod.WhatsAppClientWrapper.keyFor({ phoneNumberId });
  // WhatsApp's wrapper constructor allocates a Fastify webhook server,
  // so we only use a cached instance — created by the active voice.
  const wrapper = mod.WhatsAppClientWrapper.cache.get(key);
  if (!wrapper) {
    throw new Error(
      "Scheduled WhatsApp delivery requires the @tuttiai/whatsapp voice to be active on " +
        "the agent. Add it to your score's voices array and set WHATSAPP_PHONE_NUMBER_ID, " +
        "WHATSAPP_ACCESS_TOKEN, WHATSAPP_VERIFY_TOKEN, and WHATSAPP_APP_SECRET.",
    );
  }
  let body = content;
  if (format === "markdown") {
    body = stripMarkdown(content);
    logger.warn(
      { platform: "whatsapp", chars_before: content.length, chars_after: body.length },
      "WhatsApp does not render markdown — stripped before send",
    );
  }
  await wrapper.sendText(target.phone_number, body);
}

interface EmailWrapperOptions {
  imap: { host: string; port: number; user: string; pass: string };
  smtp: { host: string; port: number; user: string; pass: string };
  from: string;
}

function buildEmailOptions(): EmailWrapperOptions {
  const smtpHost = SecretsManager.require("TUTTI_EMAIL_SMTP_HOST");
  const smtpPort = Number.parseInt(SecretsManager.require("TUTTI_EMAIL_SMTP_PORT"), 10);
  const smtpUser = SecretsManager.require("TUTTI_EMAIL_SMTP_USER");
  // Allow a single shared password env var, mirroring the inbox adapter.
  const smtpPass =
    SecretsManager.optional("TUTTI_EMAIL_SMTP_PASSWORD") ??
    SecretsManager.require("TUTTI_EMAIL_PASSWORD");
  const from = SecretsManager.require("TUTTI_EMAIL_FROM");
  // IMAP key components are part of the wrapper's cache identity; default
  // to SMTP creds so single-host setups work without duplicate env vars.
  const imapHost = SecretsManager.optional("TUTTI_EMAIL_IMAP_HOST") ?? smtpHost;
  const imapPort = Number.parseInt(
    SecretsManager.optional("TUTTI_EMAIL_IMAP_PORT") ?? "993",
    10,
  );
  const imapUser = SecretsManager.optional("TUTTI_EMAIL_IMAP_USER") ?? smtpUser;
  const imapPass =
    SecretsManager.optional("TUTTI_EMAIL_IMAP_PASSWORD") ??
    SecretsManager.optional("TUTTI_EMAIL_PASSWORD") ??
    smtpPass;
  return {
    imap: { host: imapHost, port: imapPort, user: imapUser, pass: imapPass },
    smtp: { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass },
    from,
  };
}

async function loadVoice<M>(spec: string, importFn: DynamicImportFn): Promise<M> {
  try {
    return (await importFn(spec)) as M;
  } catch (err) {
    const short = spec.replace("@tuttiai/", "");
    throw new Error(
      `Install ${spec} to use scheduled delivery (run \`npm install ${spec}\` or \`tutti-ai add ${short}\`). ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Strip the markdown delimiters most likely to appear in agent output
// before WhatsApp send. Order matters: code spans before bold/italic so
// `*` inside backticks survives, then bold (paired) before italic (single).
const MD_LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;
const MD_CODE_BLOCK_RE = /```([\s\S]*?)```/g;
const MD_CODE_INLINE_RE = /`([^`]+)`/g;
const MD_BOLD_STARS_RE = /\*\*([^*]+)\*\*/g;
const MD_BOLD_UNDERS_RE = /__([^_]+)__/g;
// eslint-disable-next-line security/detect-unsafe-regex -- bounded, no nested quantifiers
const MD_ITALIC_STAR_RE = /(?<!\*)\*([^*\n]+)\*(?!\*)/g;
// eslint-disable-next-line security/detect-unsafe-regex -- bounded, no nested quantifiers
const MD_ITALIC_UNDER_RE = /(?<!_)_([^_\n]+)_(?!_)/g;
const MD_HEADING_RE = /^#{1,6}\s+/gm;

/**
 * Minimal markdown stripper for the WhatsApp path. Removes the
 * delimiters around bold, italic, code, links, and headings, leaving
 * the inner text intact. Not a full markdown→plaintext converter —
 * tables, blockquotes, and list bullets pass through unchanged.
 */
export function stripMarkdown(s: string): string {
  return s
    .replace(MD_LINK_RE, "$1")
    .replace(MD_CODE_BLOCK_RE, "$1")
    .replace(MD_CODE_INLINE_RE, "$1")
    .replace(MD_BOLD_STARS_RE, "$1")
    .replace(MD_BOLD_UNDERS_RE, "$1")
    .replace(MD_ITALIC_STAR_RE, "$1")
    .replace(MD_ITALIC_UNDER_RE, "$1")
    .replace(MD_HEADING_RE, "");
}
