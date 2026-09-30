/**
 * The voices the stock server image can construct from stored options.
 *
 * A fixed table, keyed by registry name, and the only place a voice key from
 * `TUTTI_VOICES` turns into code. The key is looked up here and never used to
 * build an import specifier, so a document naming `"../../evil"` finds nothing
 * rather than something.
 *
 * Each voice is imported lazily, so a library user of `@tuttiai/server` does
 * not install fifteen voices. The image carries every one of them.
 * Every entry validates with the voice's own `.strict()` config schema before
 * constructing, so an unknown option is refused rather than ignored.
 *
 * Adding a voice here also means adding it to the root `Dockerfile`, or the
 * image refuses it at start with "not installed in this image".
 */

import { SecretsManager } from "@tuttiai/core";
import type { Voice } from "@tuttiai/types";

/** One schema issue, stripped to where it is and what kind it is. Never the value. */
export interface VoiceOptionIssue {
  readonly path: string;
  readonly code: string;
}

/** What building one voice gives: the voice, or why its options were refused. */
export type VoiceBuild =
  | { readonly ok: true; readonly voice: Voice }
  | { readonly ok: false; readonly issues: readonly VoiceOptionIssue[] };

/** Builds one voice from options that have not been validated yet. */
export type VoiceBuilder = (options: unknown) => VoiceBuild;

/**
 * The part of a zod schema this module uses, stated structurally so the server
 * does not depend on whichever zod copy each voice was built against.
 */
interface OptionSchema<T> {
  safeParse(input: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: readonly { path: readonly (string | number)[]; code: string }[] };
      };
}

/**
 * Pair a voice's schema with its constructor.
 *
 * @param schema - The voice's exported config schema.
 * @param construct - Builds the voice from parsed options.
 * @returns A builder that validates first and never throws on bad options.
 */
export function fromSchema<T>(schema: OptionSchema<T>, construct: (options: T) => Voice): VoiceBuilder {
  return (options) => {
    const parsed = schema.safeParse(options);
    if (!parsed.success) {
      // Path and code only: a message can quote the received value, and the
      // value may be a token.
      const issues = parsed.error.issues.map((issue) => ({
        path: issue.path.length === 0 ? "(options)" : issue.path.join("."),
        code: issue.code,
      }));
      return { ok: false, issues };
    }
    return { ok: true, voice: construct(parsed.data) };
  };
}

/** Loads one voice's builder. Rejects when the package is not in this image. */
export type VoiceLoader = () => Promise<VoiceBuilder>;

/**
 * Where the image's Chromium lives, for the Playwright voice. Set by the
 * `Dockerfile`, because Playwright's own download does not run on Alpine.
 *
 * Read from the image's environment and never from a voice's options: a
 * stored document that could name the browser binary could name any binary.
 */
function chromiumPath(): { executablePath?: string } {
  const path = SecretsManager.optional("TUTTI_CHROMIUM_PATH");
  return path === undefined || path === "" ? {} : { executablePath: path };
}

/**
 * Every voice the stock image knows, by registry key: all fifteen the
 * framework ships.
 *
 * The first four were chosen for answering a call and returning. The rest
 * joined once each was checked to open nothing at construction: a client
 * connects on its first tool call (Discord's gateway included), and a
 * listener such as WhatsApp's webhook starts only when an inbox subscribes,
 * which this image never does. `sandbox` and `mcp` build their tools in
 * `setup()`, which `narrowVoice()` allows for.
 */
export const VOICE_LOADERS: ReadonlyMap<string, VoiceLoader> = new Map<string, VoiceLoader>([
  ["github", async () => {
    const m = await import("@tuttiai/github");
    return fromSchema(m.GitHubVoiceConfigSchema, (options) => new m.GitHubVoice(options));
  }],
  ["slack", async () => {
    const m = await import("@tuttiai/slack");
    return fromSchema(m.SlackVoiceConfigSchema, (options) => new m.SlackVoice(options));
  }],
  ["email", async () => {
    const m = await import("@tuttiai/email");
    return fromSchema(m.EmailVoiceConfigSchema, (options) => new m.EmailVoice(options));
  }],
  ["web", async () => {
    const m = await import("@tuttiai/web");
    return fromSchema(m.WebVoiceConfigSchema, (options) => new m.WebVoice(options));
  }],
  ["discord", async () => {
    const m = await import("@tuttiai/discord");
    return fromSchema(m.DiscordVoiceConfigSchema, (options) => new m.DiscordVoice(options));
  }],
  ["telegram", async () => {
    const m = await import("@tuttiai/telegram");
    return fromSchema(m.TelegramVoiceConfigSchema, (options) => new m.TelegramVoice(options));
  }],
  ["whatsapp", async () => {
    const m = await import("@tuttiai/whatsapp");
    return fromSchema(m.WhatsAppVoiceConfigSchema, (options) => new m.WhatsAppVoice(options));
  }],
  ["twitter", async () => {
    const m = await import("@tuttiai/twitter");
    return fromSchema(m.TwitterVoiceConfigSchema, (options) => new m.TwitterVoice(options));
  }],
  ["stripe", async () => {
    const m = await import("@tuttiai/stripe");
    return fromSchema(m.StripeVoiceConfigSchema, (options) => new m.StripeVoice(options));
  }],
  ["postgres", async () => {
    const m = await import("@tuttiai/postgres");
    return fromSchema(m.PostgresVoiceConfigSchema, (options) => new m.PostgresVoice(options));
  }],
  ["rag", async () => {
    const m = await import("@tuttiai/rag");
    return fromSchema(m.RagVoiceConfigSchema, (options) => m.RagVoice(options));
  }],
  ["filesystem", async () => {
    const m = await import("@tuttiai/filesystem");
    return fromSchema(m.FilesystemVoiceConfigSchema, () => new m.FilesystemVoice());
  }],
  ["playwright", async () => {
    const m = await import("@tuttiai/playwright");
    return fromSchema(m.PlaywrightVoiceConfigSchema, (options) => new m.PlaywrightVoice({ ...options, ...chromiumPath() }));
  }],
  ["sandbox", async () => {
    const m = await import("@tuttiai/sandbox");
    return fromSchema(m.SandboxVoiceConfigSchema, (options) => new m.SandboxVoice(options));
  }],
  ["mcp", async () => {
    const m = await import("@tuttiai/mcp");
    return fromSchema(m.McpVoiceConfigSchema, (options) => new m.McpVoice(options));
  }],
  ["knowledge", async () => {
    const m = await import("@tuttiai/knowledge");
    return fromSchema(m.KnowledgeVoiceConfigSchema, (options) => new m.KnowledgeVoice(options));
  }],
  ["notion", async () => {
    const m = await import("@tuttiai/notion");
    return fromSchema(m.NotionVoiceConfigSchema, (options) => new m.NotionVoice(options));
  }],
]);
