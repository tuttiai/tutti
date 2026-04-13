import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  AgentConfig,
  AgentResult,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  HookContext,
  LLMProvider,
  SessionStore,
  StopReason,
  Tool,
  ToolContext,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
  TokenUsage,
  TuttiHooks,
} from "@tuttiai/types";
import type { EventBus } from "./event-bus.js";
import { SecretsManager } from "./secrets.js";
import { PromptGuard } from "./prompt-guard.js";
import { TokenBudget } from "./token-budget.js";
import type { SemanticMemoryStore } from "./memory/semantic.js";
import type { ToolCache } from "./cache/tool-cache.js";
import { DEFAULT_WRITE_TOOLS } from "./cache/index.js";
import { logger } from "./logger.js";
import { TuttiTracer } from "./telemetry.js";
import { ToolTimeoutError, ProviderError, RateLimitError } from "./errors.js";

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_TOOL_CALLS = 20;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_HITL_TIMEOUT_S = 300;
const MAX_PROVIDER_RETRIES = 3;

const hitlRequestSchema = z.object({
  question: z.string().describe("The question to ask the human"),
  options: z.array(z.string()).optional().describe("If provided, the human picks one of these"),
  timeout_seconds: z.number().optional().describe("How long to wait before timing out (default 300)"),
});

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_PROVIDER_RETRIES || !(err instanceof ProviderError)) {
        throw err;
      }
      if (err instanceof RateLimitError && err.retryAfter) {
        logger.warn({ attempt, retryAfter: err.retryAfter }, "Rate limited, waiting before retry");
        await new Promise((r) => setTimeout(r, err.retryAfter! * 1000));
      } else {
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
        logger.warn({ attempt, delayMs }, "Provider error, retrying with backoff");
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
}

export class AgentRunner {
  private pendingHitl = new Map<string, (answer: string) => void>();

  constructor(
    private provider: LLMProvider,
    private events: EventBus,
    private sessions: SessionStore,
    private semanticMemory?: SemanticMemoryStore,
    private globalHooks?: TuttiHooks,
    private toolCache?: ToolCache,
  ) {}

  private async safeHook<T>(fn: (() => Promise<T> | T | undefined) | undefined): Promise<T | undefined> {
    if (!fn) return undefined;
    try {
      return await fn() ?? undefined;
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, "Hook error (non-fatal)");
      return undefined;
    }
  }

  /** Resolve a pending human-in-the-loop request for a session. */
  answer(sessionId: string, answer: string): void {
    const resolve = this.pendingHitl.get(sessionId);
    if (resolve) {
      this.pendingHitl.delete(sessionId);
      resolve(answer);
    }
  }

  async run(
    agent: AgentConfig,
    input: string,
    session_id?: string,
  ): Promise<AgentResult> {
    // Resolve or create session
    const session = session_id
      ? this.sessions.get(session_id)
      : this.sessions.create(agent.name);

    if (!session) {
      throw new Error(
        `Session not found: ${session_id}\n` +
        `The session may have expired or the ID is incorrect.\n` +
        `Omit session_id to start a new conversation.`,
      );
    }

    return TuttiTracer.agentRun(agent.name, session.id, async () => {
      const agentHooks = agent.hooks;
      const hookCtx: HookContext = {
        agent_name: agent.name,
        session_id: session.id,
        turn: 0,
        metadata: {},
      };

      // beforeAgentRun hooks
      await this.safeHook(() => this.globalHooks?.beforeAgentRun?.(hookCtx));
      await this.safeHook(() => agentHooks?.beforeAgentRun?.(hookCtx));

      logger.info({ agent: agent.name, session: session.id }, "Agent started");

      this.events.emit({
        type: "agent:start",
        agent_name: agent.name,
        session_id: session.id,
      });

      // Initialize voices that have setup hooks (e.g., MCP voice discovers tools)
      const voiceCtx = { session_id: session.id, agent_name: agent.name };
      for (const voice of agent.voices) {
        if (voice.setup) {
          await voice.setup(voiceCtx);
        }
      }

      // Collect all tools from all voices
      const allTools: Tool[] = [...agent.voices.flatMap((v) => v.tools)];

      // Inject HITL tool if enabled
      if (agent.allow_human_input) {
        allTools.push(this.createHitlTool(agent.name, session.id));
      }

      const toolDefs = allTools.map(toolToDefinition);

      // Add user message
      const messages: ChatMessage[] = [
        ...session.messages,
        { role: "user", content: input },
      ];

      const maxTurns = agent.max_turns ?? DEFAULT_MAX_TURNS;
      const maxToolCalls = agent.max_tool_calls ?? DEFAULT_MAX_TOOL_CALLS;
      const budget = agent.budget
        ? new TokenBudget(agent.budget, agent.model ?? "")
        : undefined;
      const totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
      let turns = 0;
      let totalToolCalls = 0;

      // Agentic loop
      while (turns < maxTurns) {
        turns++;

        logger.info({ agent: agent.name, session: session.id, turn: turns }, "Turn started");

        this.events.emit({
          type: "turn:start",
          agent_name: agent.name,
          session_id: session.id,
          turn: turns,
        });

        // Inject semantic memories into system prompt if enabled
        let systemPrompt = agent.system_prompt;
        const memCfg = agent.semantic_memory;
        if (memCfg?.enabled && this.semanticMemory) {
          const maxMemories = memCfg.max_memories ?? 5;
          const injectSystem = memCfg.inject_system !== false;
          if (injectSystem) {
            const memories = await this.semanticMemory.search(
              input,
              agent.name,
              maxMemories,
            );
            if (memories.length > 0) {
              const memoryBlock = memories
                .map((m) => `- ${m.content}`)
                .join("\n");
              systemPrompt +=
                "\n\nRelevant context from previous sessions:\n" +
                memoryBlock;
            }
          }
        }

        let request: ChatRequest = {
          model: agent.model,
          system: systemPrompt,
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
        };

        // beforeLLMCall hooks — may modify the request
        hookCtx.turn = turns;
        const globalReq = await this.safeHook(() => this.globalHooks?.beforeLLMCall?.(hookCtx, request));
        if (globalReq) request = globalReq;
        const agentReq = await this.safeHook(() => agentHooks?.beforeLLMCall?.(hookCtx, request));
        if (agentReq) request = agentReq;

        logger.debug({ agent: agent.name, model: agent.model }, "LLM request");

        this.events.emit({
          type: "llm:request",
          agent_name: agent.name,
          request,
        });

        const response = await TuttiTracer.llmCall(
          agent.model ?? "unknown",
          () => withRetry(() =>
            agent.streaming
              ? this.streamToResponse(agent.name, request)
              : this.provider.chat(request),
          ),
        );

        logger.debug(
          { agent: agent.name, stopReason: response.stop_reason, usage: response.usage },
          "LLM response",
        );

        this.events.emit({
          type: "llm:response",
          agent_name: agent.name,
          response,
        });

        // afterLLMCall hooks
        await this.safeHook(() => this.globalHooks?.afterLLMCall?.(hookCtx, response));
        await this.safeHook(() => agentHooks?.afterLLMCall?.(hookCtx, response));

        totalUsage.input_tokens += response.usage.input_tokens;
        totalUsage.output_tokens += response.usage.output_tokens;

        // Check token budget
        if (budget) {
          budget.add(response.usage.input_tokens, response.usage.output_tokens);
          const status = budget.check();
          if (status === "warning") {
            logger.warn(
              { agent: agent.name, tokens: budget.total_tokens, cost_usd: budget.estimated_cost_usd },
              "Approaching token budget limit",
            );
            this.events.emit({
              type: "budget:warning",
              agent_name: agent.name,
              tokens: budget.total_tokens,
              cost_usd: budget.estimated_cost_usd,
            });
          } else if (status === "exceeded") {
            logger.warn(
              { agent: agent.name, tokens: budget.total_tokens, cost_usd: budget.estimated_cost_usd },
              "Token budget exceeded",
            );
            this.events.emit({
              type: "budget:exceeded",
              agent_name: agent.name,
              tokens: budget.total_tokens,
              cost_usd: budget.estimated_cost_usd,
            });
            messages.push({ role: "assistant", content: response.content });
            break;
          }
        }

        // Add assistant message
        messages.push({ role: "assistant", content: response.content });

        this.events.emit({
          type: "turn:end",
          agent_name: agent.name,
          session_id: session.id,
          turn: turns,
        });

        // If the model is done talking, exit the loop
        if (response.stop_reason !== "tool_use") {
          break;
        }

        // Execute tool calls
        const toolUseBlocks = response.content.filter(
          (b): b is ToolUseBlock => b.type === "tool_use",
        );

        totalToolCalls += toolUseBlocks.length;
        if (totalToolCalls > maxToolCalls) {
          messages.push({
            role: "user",
            content: toolUseBlocks.map((block) => ({
              type: "tool_result" as const,
              tool_use_id: block.id,
              content: `Tool call rate limit exceeded: ${totalToolCalls} calls (max: ${maxToolCalls})`,
              is_error: true,
            })),
          });
          break;
        }

        const toolTimeoutMs = agent.tool_timeout_ms ?? DEFAULT_TOOL_TIMEOUT_MS;
        const toolContext: ToolContext = {
          session_id: session.id,
          agent_name: agent.name,
        };

        // Attach memory helpers if semantic memory is enabled
        if (memCfg?.enabled && this.semanticMemory) {
          const sm = this.semanticMemory;
          const agentName = agent.name;
          toolContext.memory = {
            remember: async (content, metadata = {}) => {
              await sm.add({ agent_name: agentName, content, metadata });
            },
            recall: async (query, limit) => {
              const entries = await sm.search(query, agentName, limit);
              return entries.map((e) => ({ id: e.id, content: e.content }));
            },
            forget: async (id) => {
              await sm.delete(id);
            },
          };
        }

        const toolResults: ToolResultBlock[] = await Promise.all(
          toolUseBlocks.map((block) =>
            this.executeTool(
              allTools,
              block,
              toolContext,
              toolTimeoutMs,
              hookCtx,
              agentHooks,
              agent.cache,
            ),
          ),
        );

        // Add tool results as a user message (Anthropic API format)
        messages.push({ role: "user", content: toolResults });
      }

      // Persist updated messages
      this.sessions.update(session.id, messages);

      // Extract final text output
      const lastAssistant = messages
        .filter((m) => m.role === "assistant")
        .at(-1);

      const output = extractText(lastAssistant?.content);

      logger.info(
        { agent: agent.name, session: session.id, turns, usage: totalUsage },
        "Agent finished",
      );

      this.events.emit({
        type: "agent:end",
        agent_name: agent.name,
        session_id: session.id,
      });

      const agentResult: AgentResult = {
        session_id: session.id,
        output,
        messages,
        turns,
        usage: totalUsage,
      };

      // afterAgentRun hooks
      await this.safeHook(() => this.globalHooks?.afterAgentRun?.(hookCtx, agentResult));
      await this.safeHook(() => agentHooks?.afterAgentRun?.(hookCtx, agentResult));

      return agentResult;
    });
  }

  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    toolName: string,
  ): Promise<T> {
    // Track the timer so we can clear it on the happy path. Without this,
    // a tool that finishes in 10ms still leaves a timeoutMs-long handle
    // alive, keeping the event loop running and firing a dead rejection.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ToolTimeoutError(toolName, timeoutMs)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([fn(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async streamToResponse(
    agentName: string,
    request: ChatRequest,
  ): Promise<ChatResponse> {
    const content: ContentBlock[] = [];
    let textBuffer = "";
    let usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
    let stopReason: StopReason = "end_turn";

    for await (const chunk of this.provider.stream(request)) {
      if (chunk.type === "text" && chunk.text) {
        textBuffer += chunk.text;
        this.events.emit({
          type: "token:stream",
          agent_name: agentName,
          text: chunk.text,
        });
      }
      if (chunk.type === "tool_use" && chunk.tool) {
        content.push({
          type: "tool_use",
          id: chunk.tool.id,
          name: chunk.tool.name,
          input: chunk.tool.input,
        });
      }
      if (chunk.type === "usage") {
        if (chunk.usage) usage = chunk.usage;
        if (chunk.stop_reason) stopReason = chunk.stop_reason;
      }
    }

    if (textBuffer) {
      content.unshift({ type: "text", text: textBuffer });
    }

    return { id: "", content, stop_reason: stopReason, usage };
  }

  private createHitlTool(agentName: string, sessionId: string): Tool {
    return {
      name: "request_human_input",
      description: "Pause and ask the human for guidance or approval before proceeding.",
      parameters: hitlRequestSchema,
      execute: async (input: z.infer<typeof hitlRequestSchema>): Promise<{ content: string; is_error?: boolean }> => {
        const timeout = (input.timeout_seconds ?? DEFAULT_HITL_TIMEOUT_S) * 1000;

        logger.info({ agent: agentName, question: input.question }, "Waiting for human input");

        // Set up pending resolver BEFORE emitting so synchronous handlers can call answer()
        const answer = await new Promise<string>((resolve) => {
          this.pendingHitl.set(sessionId, resolve);

          // Emit after pendingHitl is set — handlers can now call runner.answer()
          this.events.emit({
            type: "hitl:requested",
            agent_name: agentName,
            session_id: sessionId,
            question: input.question,
            options: input.options,
          });

          setTimeout(() => {
            if (this.pendingHitl.has(sessionId)) {
              this.pendingHitl.delete(sessionId);
              this.events.emit({ type: "hitl:timeout", agent_name: agentName, session_id: sessionId });
              resolve("[timeout: human did not respond within " + (timeout / 1000) + "s]");
            }
          }, timeout);
        });

        this.events.emit({
          type: "hitl:answered",
          agent_name: agentName,
          session_id: sessionId,
          answer,
        });

        return { content: "Human responded: " + answer };
      },
    };
  }

  private async executeTool(
    tools: Tool[],
    block: ToolUseBlock,
    context: ToolContext,
    timeoutMs: number,
    hookCtx?: HookContext,
    agentHooks?: TuttiHooks,
    cacheCfg?: { enabled: boolean; ttl_ms?: number; excluded_tools?: string[] },
  ): Promise<ToolResultBlock> {
    const tool = tools.find((t) => t.name === block.name);
    if (!tool) {
      const available = tools.map((t) => t.name).join(", ") || "(none)";
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: `Tool "${block.name}" not found. Available tools: ${available}`,
        is_error: true,
      };
    }

    // Cache lookup happens inside the tracer span so cache hits still show
    // up in traces as zero-cost tool calls.
    return TuttiTracer.toolCall(block.name, async () => {
      // beforeToolCall hooks — return false to block, or modified input
      if (hookCtx) {
        const globalResult = await this.safeHook(() => this.globalHooks?.beforeToolCall?.(hookCtx, block.name, block.input));
        if (globalResult === false) {
          return { type: "tool_result" as const, tool_use_id: block.id, content: "Tool call blocked by hook", is_error: true };
        }
        const agentResult = await this.safeHook(() => agentHooks?.beforeToolCall?.(hookCtx, block.name, block.input));
        if (agentResult === false) {
          return { type: "tool_result" as const, tool_use_id: block.id, content: "Tool call blocked by hook", is_error: true };
        }
      }

      logger.debug({ tool: block.name, input: block.input }, "Tool called");

      this.events.emit({
        type: "tool:start",
        agent_name: context.agent_name,
        tool_name: block.name,
        input: block.input,
      });

      // Decide whether the cache can participate for this call:
      // - cache must be attached to the runtime AND enabled on the agent
      // - tool must not appear in the built-in write-tool list
      // - tool must not appear in the agent's custom excluded_tools list
      const cacheable =
        !!this.toolCache &&
        !!cacheCfg?.enabled &&
        !DEFAULT_WRITE_TOOLS.includes(block.name) &&
        !(cacheCfg.excluded_tools ?? []).includes(block.name);

      // Security: scope cache keys by agent_name so a poisoned tool result
      // cached by one agent can't be read back by another agent with a
      // different trust model. Agents with the same name (same trust domain)
      // still share the cache — that's the intended win.
      const scopedTool = `${context.agent_name}::${block.name}`;

      try {
        // Validate input with Zod
        const parsed = tool.parameters.parse(block.input);

        // Cache lookup on the parsed input so semantically-equal inputs hit.
        if (cacheable && this.toolCache) {
          const cached = await this.toolCache.get(scopedTool, parsed);
          if (cached) {
            this.events.emit({
              type: "cache:hit",
              agent_name: context.agent_name,
              tool: block.name,
            });
            this.events.emit({
              type: "tool:end",
              agent_name: context.agent_name,
              tool_name: block.name,
              result: cached,
            });
            return {
              type: "tool_result" as const,
              tool_use_id: block.id,
              content: PromptGuard.wrap(block.name, cached.content),
              is_error: cached.is_error,
            };
          }
          this.events.emit({
            type: "cache:miss",
            agent_name: context.agent_name,
            tool: block.name,
          });
        }

        let result = await this.executeWithTimeout(
          () => tool.execute(parsed, context),
          timeoutMs,
          block.name,
        );

        // Populate cache with the successful raw result. Skip error results
        // so transient failures don't get pinned for minutes.
        if (cacheable && this.toolCache && !result.is_error) {
          await this.toolCache.set(
            scopedTool,
            parsed,
            result,
            cacheCfg?.ttl_ms,
          );
        }

        // afterToolCall hooks — may modify result
        if (hookCtx) {
          const globalMod = await this.safeHook(() => this.globalHooks?.afterToolCall?.(hookCtx, block.name, result));
          if (globalMod) result = globalMod;
          const agentMod = await this.safeHook(() => agentHooks?.afterToolCall?.(hookCtx, block.name, result));
          if (agentMod) result = agentMod;
        }

        logger.debug({ tool: block.name, result: result.content }, "Tool completed");

        this.events.emit({
          type: "tool:end",
          agent_name: context.agent_name,
          tool_name: block.name,
          result,
        });

        // Scan for prompt injection and wrap content
        const scan = PromptGuard.scan(result.content);
        if (!scan.safe) {
          logger.warn(
            { tool: block.name, patterns: scan.found },
            "Potential prompt injection detected in tool output",
          );
          this.events.emit({
            type: "security:injection_detected",
            agent_name: context.agent_name,
            tool_name: block.name,
            patterns: scan.found,
          });
        }

        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: PromptGuard.wrap(block.name, result.content),
          is_error: result.is_error,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error({ error: message, tool: block.name }, "Tool failed");

        this.events.emit({
          type: "tool:error",
          agent_name: context.agent_name,
          tool_name: block.name,
          error: error instanceof Error ? error : new Error(message),
        });

        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: SecretsManager.redact(`Tool execution error: ${message}`),
          is_error: true,
        };
      }
    });
  }
}

function toolToDefinition(tool: Tool): ToolDefinition {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Zod generic variance: Tool<unknown> vs zodToJsonSchema's expected ZodType<any>
  const jsonSchema = zodToJsonSchema(tool.parameters, { target: "openApi3" });
  return {
    name: tool.name,
    description: tool.description,
    input_schema: jsonSchema as Record<string, unknown>,
  };
}

function extractText(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}
