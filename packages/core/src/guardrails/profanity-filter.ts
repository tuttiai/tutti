/**
 * Built-in guardrail: replaces profanity in text with `[filtered]`.
 *
 * Uses a static word list matched as whole words (case-insensitive).
 * Not exhaustive — callers can extend the list via the `extraWords` option.
 */

import type { GuardrailHook } from "@tuttiai/types";

/** Default profanity word list — common English profanities. */
const DEFAULT_WORDS: readonly string[] = [
  "ass",
  "asshole",
  "bastard",
  "bitch",
  "bullshit",
  "crap",
  "damn",
  "dick",
  "fuck",
  "fucking",
  "hell",
  "motherfucker",
  "piss",
  "shit",
  "slut",
  "whore",
];

export interface ProfanityFilterOptions {
  /** Additional words to include in the filter. */
  extraWords?: string[];
}

/**
 * Creates a guardrail hook that replaces profanity with `[filtered]`.
 *
 * @param options - Optional configuration with extra words.
 * @returns A {@link GuardrailHook} suitable for {@link AgentConfig.afterRun}.
 *
 * @example
 * const agent: AgentConfig = {
 *   // ...
 *   afterRun: profanityFilter(),
 * };
 */
export function profanityFilter(options: ProfanityFilterOptions = {}): GuardrailHook {
  const words = [...DEFAULT_WORDS, ...(options.extraWords ?? [])];
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`\\b(${escaped.join("|")})\\b`, "gi");

  return (text: string): Promise<string> => {
    return Promise.resolve(text.replace(pattern, "[filtered]"));
  };
}
