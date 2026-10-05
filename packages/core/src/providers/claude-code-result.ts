import type { ChatRequest, ChatResponse } from "@tuttiai/types";

import { AuthenticationError, ProviderError, RateLimitError, RunAbortedError } from "../errors.js";
import { logger } from "../logger.js";
import { SecretsManager } from "../secrets.js";
import type { ClaudeCodeRunResult } from "./claude-code-process.js";
import { ClaudeCodeResultSchema, parseReply } from "./claude-code-protocol.js";
import type { ClaudeCodeResult } from "./claude-code-protocol.js";

const PROVIDER = "claude-code";

/**
 * Whether a `--resume` failed because the CLI no longer has the session, as
 * after a restart that cleared its session files. The call is then retried
 * fresh rather than failed.
 *
 * @param run - The CLI run.
 * @returns True when the session was not found.
 */
export function isMissingSession(run: ClaudeCodeRunResult): boolean {
  return /no conversation found/i.test(run.stderr) || /no conversation found/i.test(run.stdout);
}

/**
 * Validate a CLI run and map its failures onto Tutti's errors.
 *
 * @param run - The CLI run.
 * @param command - The CLI that was run, for the not-found hint.
 * @returns The CLI's result.
 * @throws {ProviderError} When the CLI could not start, timed out, failed or answered malformed.
 * @throws {AuthenticationError} When the CLI is not signed in.
 * @throws {RateLimitError} When the account's usage limit is reached.
 * @throws {RunAbortedError} When the run's signal stopped the process.
 */
export function parseResult(run: ClaudeCodeRunResult, command: string): ClaudeCodeResult {
  if (run.spawn_error) {
    const hint = run.spawn_error.code === "ENOENT"
      ? `"${command}" was not found. Install Claude Code (npm install -g @anthropic-ai/claude-code) or set the command option.`
      : run.spawn_error.message;
    throw new ProviderError(`Could not start Claude Code: ${hint}`, { provider: PROVIDER });
  }
  if (run.aborted === true) throw new RunAbortedError("the Claude Code process was stopped by the run's signal"); // not retried: not a ProviderError
  if (run.timed_out) {
    throw new ProviderError("Claude Code did not answer in time. Raise timeout_ms, or check the CLI runs.", { provider: PROVIDER });
  }
  const parsed = ClaudeCodeResultSchema.safeParse(safeJson(run.stdout));
  if (!parsed.success) {
    const detail = SecretsManager.redact(run.stderr.trim() || run.stdout.trim()).slice(0, 500);
    throw new ProviderError(`Claude Code exited ${String(run.exit_code)} without a result: ${detail}`, { provider: PROVIDER });
  }
  if (parsed.data.is_error) throw mapError(parsed.data);
  return parsed.data;
}

function mapError(result: ClaudeCodeResult): Error {
  const status = result.api_error_status ?? undefined;
  const message = SecretsManager.redact(result.result ?? "unknown error");
  logger.error({ provider: PROVIDER, status, error: message }, "Provider request failed");
  if (status === 401 || status === 403) return new AuthenticationError(PROVIDER);
  if (status === 429 || /usage limit/i.test(message)) return new RateLimitError(PROVIDER);
  return new ProviderError(
    `Claude Code error: ${message}\nIf it is not signed in, run \`claude setup-token\` and set CLAUDE_CODE_OAUTH_TOKEN.`,
    { provider: PROVIDER, ...(status !== undefined && { status }) },
  );
}

/**
 * Turn the CLI's result into a chat response. `input_tokens` is the whole
 * prompt; the cache figures are the parts of it read from and written to
 * Claude Code's prompt cache.
 *
 * @param result - The validated CLI result.
 * @param request - The request it answers, for the tools that were offered.
 * @returns The chat response.
 * @throws {ProviderError} When the structured reply does not match the tool protocol.
 */
export function toResponse(result: ClaudeCodeResult, request: ChatRequest): ChatResponse {
  const content = parseReply(result.structured_output, request.tools);
  if (content === undefined) {
    throw new ProviderError("Claude Code returned a reply that does not match the tool protocol.", { provider: PROVIDER });
  }
  const usage = result.usage;
  return {
    id: result.session_id ?? "",
    content,
    stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    usage: usage
      ? {
          input_tokens: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
        }
      : { input_tokens: 0, output_tokens: 0 },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
