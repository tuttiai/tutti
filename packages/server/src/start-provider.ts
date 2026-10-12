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
 * `--build-arg CLAUDE_CODE_VERSION=<version>`. With a usable `TUTTI_STATE_DIR`
 * it keeps its session registry there, and runs the CLI with
 * `CLAUDE_CONFIG_DIR=<dir>/claude` unless that variable is already set, so
 * the CLI's sessions survive a restart too.
 */

import {
  AnthropicProvider,
  ClaudeCodeProvider,
  GeminiProvider,
  OpenAIProvider,
} from "@tuttiai/core";
import type { ClaudeCodeProviderOptions } from "@tuttiai/core";
import type { LLMProvider } from "@tuttiai/types";

import type { ReadVariable } from "./start-env.js";
import type { StartStatePaths } from "./start-state.js";

/** The values `TUTTI_PROVIDER` accepts. */
export const START_PROVIDERS = ["anthropic", "openai", "gemini", "claude-code"] as const;

/**
 * Build the server's provider from the value of `TUTTI_PROVIDER`.
 *
 * @param name - The variable's value, or `undefined` when it is unset.
 * @param state - `TUTTI_STATE_DIR`'s paths, or `undefined` when it is unset or unusable.
 * @param read - Reads one variable; used for `CLAUDE_CONFIG_DIR`. Default reads nothing.
 * @returns A provider instance.
 * @throws {Error} When the name is not one of {@link START_PROVIDERS}.
 */
export function buildStartProvider(
  name: string | undefined,
  state?: StartStatePaths,
  read: ReadVariable = () => undefined,
): LLMProvider {
  switch (name ?? "anthropic") {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider();
    case "gemini":
      return new GeminiProvider();
    case "claude-code":
      return new ClaudeCodeProvider(startClaudeCodeOptions(state, read));
    default:
      throw new Error(
        `Unknown provider "${name ?? ""}".\n` +
          `Set TUTTI_PROVIDER to one of: ${START_PROVIDERS.join(", ")}`,
      );
  }
}

/**
 * The Claude Code provider's options for a state directory.
 *
 * @param state - The usable state paths, or `undefined` to keep everything as before.
 * @param read - Reads one variable; used for `CLAUDE_CONFIG_DIR`.
 * @returns The registry file and, unless `CLAUDE_CONFIG_DIR` is already set, the CLI's config directory.
 *
 * @example
 * const options = startClaudeCodeOptions(state, (key) => SecretsManager.optional(key));
 */
export function startClaudeCodeOptions(
  state: StartStatePaths | undefined,
  read: ReadVariable,
): ClaudeCodeProviderOptions {
  if (state === undefined) return {};
  const inherited = read("CLAUDE_CONFIG_DIR")?.trim() ?? "";
  return {
    sessions_file: state.claude_code_sessions,
    // A CLAUDE_CONFIG_DIR someone set on purpose wins over the state directory.
    ...(inherited === "" && { config_dir: state.claude_config }),
  };
}
