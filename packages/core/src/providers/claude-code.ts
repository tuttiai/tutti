import { tmpdir } from "node:os";

import type { ChatRequest, ChatResponse, LLMProvider, StreamChunk } from "@tuttiai/types";

import { AuthenticationError, ProviderError, RateLimitError } from "../errors.js";
import { logger } from "../logger.js";
import { SecretsManager } from "../secrets.js";
import { runClaudeCode } from "./claude-code-process.js";
import type { ClaudeCodeRunner, ClaudeCodeRunResult } from "./claude-code-process.js";
import {
  buildPrompt,
  buildReplySchema,
  buildSystemPrompt,
  ClaudeCodeResultSchema,
  parseReply,
} from "./claude-code-protocol.js";
import type { ClaudeCodeResult } from "./claude-code-protocol.js";

const PROVIDER = "claude-code";
const DEFAULT_TIMEOUT_MS = 600_000;
// One StructuredOutput call plus room for a stray native tool attempt.
const MAX_TURNS = "4";

/** Options for {@link ClaudeCodeProvider}. */
export interface ClaudeCodeProviderOptions {
  /** The CLI to run. Default `claude`, resolved on `PATH`. */
  command?: string;
  /** Kill a call that runs longer than this. Default 600000 (10 minutes). */
  timeout_ms?: number;
  /** Working directory for the CLI. Default the OS temp directory. */
  cwd?: string;
  /** Replaces the process runner. For tests. */
  runner?: ClaudeCodeRunner;
}

/**
 * An {@link LLMProvider} that answers through a locally installed Claude Code
 * CLI (`claude -p`), using whatever login that CLI already holds.
 *
 * Tutti never reads, stores or forwards a credential for this provider. Sign
 * the CLI in yourself: `claude` then `/login`, or set `CLAUDE_CODE_OAUTH_TOKEN`
 * from `claude setup-token`. If `ANTHROPIC_API_KEY` is set, Claude Code uses
 * it instead and bills the API.
 *
 * Meant for running your own agents on your own machine. Serving other
 * people through a personal Claude subscription is not permitted by
 * Anthropic's terms; use {@link AnthropicProvider} with an API key for that.
 *
 * Every Claude Code tool, MCP server, hook and CLAUDE.md is switched off, so
 * the CLI acts as a plain model and only the agent's own voices run. Each
 * call is stateless and carries the whole conversation. `max_tokens`,
 * `temperature` and `stop_sequences` are not supported by the CLI and are
 * ignored, and `stream()` yields the reply once it is complete.
 *
 * @example
 * const score = defineScore({
 *   provider: new ClaudeCodeProvider(),
 *   default_model: "claude-sonnet-5",
 *   agents: { assistant: { name: "assistant", system_prompt: "…", voices: [] } },
 * });
 */
export class ClaudeCodeProvider implements LLMProvider {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly cwd: string;
  private readonly runner: ClaudeCodeRunner;

  constructor(options: ClaudeCodeProviderOptions = {}) {
    this.command = options.command ?? "claude";
    this.timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    // Outside any project, so no project settings or CLAUDE.md apply.
    this.cwd = options.cwd ?? tmpdir();
    this.runner = options.runner ?? runClaudeCode;
    if (SecretsManager.optional("ANTHROPIC_API_KEY") !== undefined) {
      logger.warn(
        { provider: PROVIDER },
        "ANTHROPIC_API_KEY is set, so Claude Code will bill the API rather than a subscription",
      );
    }
  }

  /**
   * Answer one turn through `claude -p`.
   *
   * @param request - Messages, system prompt, tools and model for the turn.
   * @returns The reply as text and/or tool_use blocks.
   * @throws {ProviderError} When no model is set, the CLI is missing or fails, or the reply is malformed.
   * @throws {AuthenticationError} When the CLI is not signed in.
   * @throws {RateLimitError} When the account's usage limit is reached.
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!request.model) {
      throw new ProviderError(
        "ClaudeCodeProvider requires a model on ChatRequest.\n" +
          "Set model on the agent or default_model on the score.",
        { provider: PROVIDER },
      );
    }
    const run = await this.runner({
      command: this.command,
      args: buildArgs(request, request.model),
      stdin: buildPrompt(request),
      timeout_ms: this.timeoutMs,
      cwd: this.cwd,
    });
    return toResponse(parseResult(run, this.command), request);
  }

  /**
   * Streaming interface over {@link chat}. The CLI's reply arrives as one
   * structured object, so the text is yielded in a single chunk.
   *
   * @param request - Messages, system prompt, tools and model for the turn.
   * @returns Text, then each tool call, then usage.
   */
  async *stream(request: ChatRequest): AsyncGenerator<StreamChunk> {
    const response = await this.chat(request);
    for (const block of response.content) {
      if (block.type === "text") yield { type: "text", text: block.text };
      if (block.type === "tool_use") {
        yield { type: "tool_use", tool: { id: block.id, name: block.name, input: block.input } };
      }
    }
    yield { type: "usage", usage: response.usage, stop_reason: response.stop_reason };
  }
}

function buildArgs(request: ChatRequest, model: string): string[] {
  return [
    "-p",
    "--output-format", "json",
    "--model", model,
    "--system-prompt", buildSystemPrompt(request),
    "--json-schema", buildReplySchema(request),
    "--tools", "",
    "--strict-mcp-config",
    "--safe-mode",
    "--no-session-persistence",
    "--max-turns", MAX_TURNS,
  ];
}

function parseResult(run: ClaudeCodeRunResult, command: string): ClaudeCodeResult {
  if (run.spawn_error) {
    const hint = run.spawn_error.code === "ENOENT"
      ? `"${command}" was not found. Install Claude Code (npm install -g @anthropic-ai/claude-code) or set the command option.`
      : run.spawn_error.message;
    throw new ProviderError(`Could not start Claude Code: ${hint}`, { provider: PROVIDER });
  }
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

function toResponse(result: ClaudeCodeResult, request: ChatRequest): ChatResponse {
  const content = parseReply(result.structured_output, request.tools);
  if (content === undefined) {
    throw new ProviderError("Claude Code returned a reply that does not match the tool protocol.", { provider: PROVIDER });
  }
  const usage = result.usage;
  return {
    id: result.session_id ?? "",
    content,
    stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    usage: {
      input_tokens: usage
        ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        : 0,
      output_tokens: usage?.output_tokens ?? 0,
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
