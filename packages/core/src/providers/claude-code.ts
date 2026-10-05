import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

import type { ChatRequest, ChatResponse, LLMProvider, StreamChunk } from "@tuttiai/types";

import { ProviderError } from "../errors.js";
import { logger } from "../logger.js";
import { SecretsManager } from "../secrets.js";
import { runClaudeCode } from "./claude-code-process.js";
import type { ClaudeCodeRunner, ClaudeCodeRunResult } from "./claude-code-process.js";
import { buildDeltaPrompt, buildPrompt, buildReplySchema, buildSystemPrompt } from "./claude-code-protocol.js";
import type { ClaudeCodeResult } from "./claude-code-protocol.js";
import { isMissingSession, parseResult, toResponse } from "./claude-code-result.js";
import { ClaudeCodeSessions } from "./claude-code-sessions.js";
import type { SessionResume } from "./claude-code-sessions.js";

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
  /**
   * Resume the Claude Code session that already holds a conversation, sending
   * only the messages added since, so its prompt cache is read rather than
   * rewritten every turn. Default true. Sessions are then kept as files under
   * the CLI's own `~/.claude/projects`, as an interactive session's are; set
   * false to keep nothing on disk and send the whole transcript every call.
   */
  reuse_sessions?: boolean;
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
 * the CLI acts as a plain model and only the agent's own voices run. A
 * conversation's first call carries the whole transcript; each later call
 * resumes that session with only the new messages (see `reuse_sessions`),
 * falling back to the whole transcript whenever the history no longer matches
 * what the session holds. `max_tokens`,
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
  private readonly sessions: ClaudeCodeSessions | undefined;

  constructor(options: ClaudeCodeProviderOptions = {}) {
    this.command = options.command ?? "claude";
    this.timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    // Outside any project, so no project settings or CLAUDE.md apply.
    this.cwd = options.cwd ?? tmpdir();
    this.runner = options.runner ?? runClaudeCode;
    this.sessions = options.reuse_sessions === false ? undefined : new ClaudeCodeSessions();
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
   * @throws {RunAbortedError} When `request.signal` aborts; the process is killed.
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!request.model) {
      throw new ProviderError(
        "ClaudeCodeProvider requires a model on ChatRequest.\n" +
          "Set model on the agent or default_model on the score.",
        { provider: PROVIDER },
      );
    }
    const resume = this.sessions?.take(request);
    const result = resume ? await this.resumed(request, resume) : await this.fresh(request);
    const response = toResponse(result, request);
    if (result.session_id) this.sessions?.keep(request, response.content, result.session_id);
    return response;
  }

  private async resumed(request: ChatRequest, resume: SessionResume): Promise<ClaudeCodeResult> {
    const run = await this.invoke(request, ["--resume", resume.session_id], buildDeltaPrompt(request.messages, resume.delta));
    if (!isMissingSession(run)) return parseResult(run, this.command);
    logger.info({ provider: PROVIDER }, "Claude Code session no longer exists; sending the whole conversation");
    return this.fresh(request);
  }

  private async fresh(request: ChatRequest): Promise<ClaudeCodeResult> {
    const session = this.sessions ? ["--session-id", randomUUID()] : ["--no-session-persistence"];
    return parseResult(await this.invoke(request, session, buildPrompt(request)), this.command);
  }

  private invoke(request: ChatRequest, session: string[], stdin: string): Promise<ClaudeCodeRunResult> {
    return this.runner({
      command: this.command,
      args: [...buildArgs(request), ...session],
      stdin,
      timeout_ms: this.timeoutMs,
      cwd: this.cwd,
      ...(request.signal !== undefined && { signal: request.signal }),
    });
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

function buildArgs(request: ChatRequest): string[] {
  return [
    "-p",
    "--output-format", "json",
    "--model", request.model ?? "",
    "--system-prompt", buildSystemPrompt(request),
    "--json-schema", buildReplySchema(request),
    "--tools", "",
    "--strict-mcp-config",
    "--safe-mode",
    "--max-turns", MAX_TURNS,
  ];
}
