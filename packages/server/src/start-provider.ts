/**
 * The provider `start.ts` builds from `TUTTI_PROVIDER`.
 *
 * | Value | Provider | Credential it reads |
 * |---|---|---|
 * | absent or `anthropic` | `AnthropicProvider` | `ANTHROPIC_API_KEY` |
 * | `openai` | `OpenAIProvider` | `OPENAI_API_KEY` |
 * | `gemini` | `GeminiProvider` | `GEMINI_API_KEY` |
 * | `claude-code` | `ClaudeCodeProvider` | none: the `claude` CLI's own login, e.g. `CLAUDE_CODE_OAUTH_TOKEN` |
 *
 * `claude-code` needs the CLI in the image; build it with
 * `--build-arg CLAUDE_CODE_VERSION=<version>`.
 */

import {
  AnthropicProvider,
  ClaudeCodeProvider,
  GeminiProvider,
  OpenAIProvider,
} from "@tuttiai/core";
import type { LLMProvider } from "@tuttiai/types";

/** The values `TUTTI_PROVIDER` accepts. */
export const START_PROVIDERS = ["anthropic", "openai", "gemini", "claude-code"] as const;

/**
 * Build the server's provider from the value of `TUTTI_PROVIDER`.
 *
 * @param name - The variable's value, or `undefined` when it is unset.
 * @returns A provider instance.
 * @throws {Error} When the name is not one of {@link START_PROVIDERS}.
 */
export function buildStartProvider(name: string | undefined): LLMProvider {
  switch (name ?? "anthropic") {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider();
    case "gemini":
      return new GeminiProvider();
    case "claude-code":
      return new ClaudeCodeProvider();
    default:
      throw new Error(
        `Unknown provider "${name ?? ""}".\n` +
          `Set TUTTI_PROVIDER to one of: ${START_PROVIDERS.join(", ")}`,
      );
  }
}
