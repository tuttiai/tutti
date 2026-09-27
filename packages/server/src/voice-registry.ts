/**
 * The voices the stock server image can construct from stored options.
 *
 * A fixed table, keyed by registry name, and the only place a voice key from
 * `TUTTI_VOICES` turns into code. The key is looked up here and never used to
 * build an import specifier, so a document naming `"../../evil"` finds nothing
 * rather than something.
 *
 * Each voice is imported lazily, so a library user of `@tuttiai/server` does
 * not install fifteen voices, and the image carries only the ones listed here.
 * Every entry validates with the voice's own `.strict()` config schema before
 * constructing, so an unknown option is refused rather than ignored.
 *
 * Adding a voice here also means adding it to the root `Dockerfile`, or the
 * image refuses it at start with "not installed in this image".
 */

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
 * Every voice the stock image knows, by registry key.
 *
 * Four to start, chosen because each is request and response rather than a
 * long-lived listener: `github`, `slack` and `email` carry a credential, and
 * `web` needs none.
 */
export const VOICE_LOADERS: ReadonlyMap<string, VoiceLoader> = new Map<string, VoiceLoader>([
  [
    "github",
    async () => {
      const m = await import("@tuttiai/github");
      return fromSchema(m.GitHubVoiceConfigSchema, (options) => new m.GitHubVoice(options));
    },
  ],
  [
    "slack",
    async () => {
      const m = await import("@tuttiai/slack");
      return fromSchema(m.SlackVoiceConfigSchema, (options) => new m.SlackVoice(options));
    },
  ],
  [
    "email",
    async () => {
      const m = await import("@tuttiai/email");
      return fromSchema(m.EmailVoiceConfigSchema, (options) => new m.EmailVoice(options));
    },
  ],
  [
    "web",
    async () => {
      const m = await import("@tuttiai/web");
      return fromSchema(m.WebVoiceConfigSchema, (options) => new m.WebVoice(options));
    },
  ],
]);
