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
  RunContext,
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
import type { Checkpoint, CheckpointStore } from "./checkpoint/index.js";
import type { EventBus } from "./event-bus.js";
import { SecretsManager } from "./secrets.js";
import { PromptGuard } from "./prompt-guard.js";
import { TokenBudget } from "./token-budget.js";
import type { SemanticMemoryStore } from "./memory/semantic.js";
import { createUserMemoryStore } from "./memory/user/index.js";
import type {
  AgentRunOptions,
  StoreOptions,
  UserMemory,
  UserMemoryStore,
} from "./memory/user/types.js";
import type { ToolCache } from "./cache/tool-cache.js";
import { DEFAULT_WRITE_TOOLS } from "./cache/index.js";
import { getRunCost } from "@tuttiai/telemetry";
import { logger } from "./logger.js";
import { Tracing, getCurrentTraceId } from "./telemetry.js";
import type { InterruptRequest, InterruptStore } from "./interrupt/index.js";
import { needsApproval } from "./interrupt/index.js";
import {
  InterruptDeniedError,
  ToolTimeoutError,
  ProviderError,
  RateLimitError,
  StructuredOutputError,
} from "./errors.js";

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_TOOL_CALLS = 20;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_HITL_TIMEOUT_S = 300;
const MAX_PROVIDER_RETRIES = 3;
const DEFAULT_STRUCTURED_OUTPUT_MAX_RETRIES = 3;

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
        const retryAfter = err.retryAfter;
        logger.warn({ attempt, retryAfter }, "Rate limited, waiting before retry");
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
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
  /**
   * Lazily-constructed user-memory stores keyed by agent name. One store
   * per agent so different agents can pick different backends. Tests
   * pre-populate via {@link setUserMemoryStore} to inject mocks.
   */
  private userMemoryStores = new Map<string, UserMemoryStore>();
  /**
   * In-memory resolvers for interrupts waiting on operator approval.
   * Keyed by `interrupt_id`. Populated in {@link awaitApproval} before
   * the `interrupt:requested` event fires so `resolveInterrupt` calls
   * that arrive synchronously still land on a registered resolver.
   */
  private pendingInterrupts = new Map<
    string,
    { resolve: (r: InterruptRequest) => void; reject: (err: Error) => void }
  >();

  constructor(
    private provider: LLMProvider,
    private events: EventBus,
    private sessions: SessionStore,
    private semanticMemory?: SemanticMemoryStore,
    private globalHooks?: TuttiHooks,
    private toolCache?: ToolCache,
    private checkpointStore?: CheckpointStore,
    private interruptStore?: InterruptStore,
  ) {}

  /**
   * Approve or deny a pending interrupt. Updates the
   * {@link InterruptStore} and, if the run that raised the interrupt
   * is still waiting in this process, resolves the pending tool call
   * (approval) or rejects it with {@link InterruptDeniedError} (denial).
   *
   * Idempotent: resolving an already-resolved interrupt returns the
   * existing record without disturbing anything in-memory.
   */
  async resolveInterrupt(
    interrupt_id: string,
    status: "approved" | "denied",
    options: { resolved_by?: string; denial_reason?: string } = {},
  ): Promise<InterruptRequest> {
    if (!this.interruptStore) {
      throw new Error(
        "AgentRunner.resolveInterrupt: no InterruptStore is configured. " +
          "Construct AgentRunner / TuttiRuntime with one to use requireApproval.",
      );
    }
    const resolved = await this.interruptStore.resolve(interrupt_id, status, options);

    const pending = this.pendingInterrupts.get(interrupt_id);
    if (pending) {
      this.pendingInterrupts.delete(interrupt_id);
      if (resolved.status === "approved") {
        pending.resolve(resolved);
      } else {
        pending.reject(
          new InterruptDeniedError(
            resolved.tool_name,
            resolved.denial_reason ?? "denied",
            resolved.interrupt_id,
          ),
        );
      }
    }

    this.events.emit({
      type: "interrupt:resolved",
      session_id: resolved.session_id,
      tool_name: resolved.tool_name,
      interrupt_id: resolved.interrupt_id,
      status: resolved.status as "approved" | "denied",
      ...(resolved.denial_reason !== undefined
        ? { denial_reason: resolved.denial_reason }
        : {}),
      ...(resolved.resolved_by !== undefined
        ? { resolved_by: resolved.resolved_by }
        : {}),
    });

    return resolved;
  }

  /**
   * Suspend the calling tool call until an operator calls
   * {@link resolveInterrupt}. Throws when no {@link InterruptStore} is
   * configured — a `requireApproval` pattern that fires with no store
   * is almost certainly a misconfiguration.
   */
  private async awaitApproval(
    session_id: string,
    tool_name: string,
    tool_args: unknown,
  ): Promise<InterruptRequest> {
    if (!this.interruptStore) {
      throw new Error(
        `Tool "${tool_name}" matches requireApproval but no InterruptStore is configured.\n` +
          `Pass one to AgentRunner / TuttiRuntime so interrupts can be persisted.`,
      );
    }

    const request = await this.interruptStore.create({
      session_id,
      tool_name,
      tool_args,
    });

    return new Promise<InterruptRequest>((resolve, reject) => {
      // Register the resolver BEFORE emitting so a synchronous handler
      // that calls resolveInterrupt() immediately still finds a waiter.
      this.pendingInterrupts.set(request.interrupt_id, { resolve, reject });

      this.events.emit({
        type: "interrupt:requested",
        session_id,
        tool_name,
        interrupt_id: request.interrupt_id,
        tool_args,
      });

      logger.info(
        { interrupt_id: request.interrupt_id, tool: tool_name, session: session_id },
        "Tool call paused for human approval",
      );
    });
  }

  /**
   * Test seam — pre-register a user-memory store for an agent so tests
   * can inject mocks without going through `createUserMemoryStore`. Also
   * useful for callers who want to share one store across multiple agents.
   */
  setUserMemoryStore(agent_name: string, store: UserMemoryStore): void {
    this.userMemoryStores.set(agent_name, store);
  }

  /**
   * Resolve the user-memory store for an agent, constructing it lazily
   * from `agent.memory.user_memory` config on first use. Returns
   * `undefined` when the agent has no user-memory configuration.
   */
  private getUserMemoryStore(agent: AgentConfig): UserMemoryStore | undefined {
    const cfg = agent.memory?.user_memory;
    if (!cfg) return undefined;
    let store = this.userMemoryStores.get(agent.name);
    if (!store) {
      store = createUserMemoryStore(cfg);
      this.userMemoryStores.set(agent.name, store);
    }
    return store;
  }

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
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    // session_id can come either from the positional arg (legacy) or the
    // options bag (new). Positional wins on conflict for back-compat.
    const resolvedSessionId = session_id ?? options?.session_id;
    const userId = options?.user_id;

    // Resolve or create session
    const session = resolvedSessionId
      ? this.sessions.get(resolvedSessionId)
      : this.sessions.create(agent.name);

    if (!session) {
      throw new Error(
        `Session not found: ${resolvedSessionId}\n` +
        `The session may have expired or the ID is incorrect.\n` +
        `Omit session_id to start a new conversation.`,
      );
    }

    return Tracing.agentRun(agent.name, session.id, agent.model, async () => {
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

      // Input guardrail — may modify or block the input before any turn.
      const runCtx: RunContext = { agent_name: agent.name, session_id: session.id };
      let guardedInput = input;
      if (agent.beforeRun) {
        const beforeRun = agent.beforeRun;
        const result = await Tracing.guardrail(
          "beforeRun",
          () => Promise.resolve(beforeRun(guardedInput, runCtx)),
          (r) => (typeof r === "string" ? "redact" : "pass"),
        );
        if (typeof result === "string") {
          guardedInput = result;
        }
      }

      // Durable-checkpoint resume: if the agent opted in and a checkpoint
      // exists for this session, splice its state back in before we build
      // the message list. Only `awaiting_tool_results=true` checkpoints are
      // safe to resume automatically — they sit at a mid-cycle boundary
      // where the LLM's next move is to consume the tool_results already
      // in the message list. End-of-turn checkpoints aren't saved (the
      // run exits cleanly), so we don't need to handle that branch.
      const durableEnabled = agent.durable !== undefined && agent.durable !== false;
      const checkpointStore = this.checkpointStore;
      const checkpoint =
        durableEnabled && checkpointStore
          ? await Tracing.checkpoint(session.id, 0, () =>
              checkpointStore.loadLatest(session.id),
            )
          : null;
      const resuming = !!checkpoint && checkpoint.state.awaiting_tool_results === true;

      const messages: ChatMessage[] = resuming && checkpoint
        ? [...checkpoint.messages]
        : [...session.messages, { role: "user", content: guardedInput }];

      const maxTurns = agent.max_turns ?? DEFAULT_MAX_TURNS;
      const maxToolCalls = agent.max_tool_calls ?? DEFAULT_MAX_TOOL_CALLS;
      const budget = agent.budget
        ? new TokenBudget(agent.budget, agent.model ?? "")
        : undefined;
      const totalUsage: TokenUsage =
        resuming && checkpoint
          ? {
              input_tokens: checkpoint.state.prompt_tokens_used,
              output_tokens: checkpoint.state.completion_tokens_used,
            }
          : { input_tokens: 0, output_tokens: 0 };
      let turns = resuming && checkpoint ? checkpoint.turn : 0;
      let totalToolCalls = 0;
      // Tracks the highest turn a checkpoint was successfully written for.
      // Used to log the last durable point if the loop later throws.
      let lastCheckpointedTurn = resuming && checkpoint ? checkpoint.turn : -1;

      if (resuming && checkpoint) {
        logger.info(
          { agent: agent.name, session: session.id, turn: checkpoint.turn },
          "Resuming from checkpoint",
        );
        this.events.emit({
          type: "checkpoint:restored",
          session_id: session.id,
          turn: checkpoint.turn,
        });
      }

      // Build base system prompt — append structured output instruction when
      // an outputSchema is configured so the LLM knows the expected format.
      let baseSystemPrompt = agent.system_prompt;
      if (agent.outputSchema) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Zod generic variance
        const outputJsonSchema = zodToJsonSchema(agent.outputSchema, { target: "openApi3" });
        baseSystemPrompt +=
          "\n\nYou must respond with a valid JSON object matching this schema: " +
          JSON.stringify(outputJsonSchema) +
          ". No other text.";
      }

      // Inject user memories ONCE before the first turn, into the base
      // prompt so they persist for every subsequent turn. Search uses the
      // raw input so the most contextually relevant memories surface.
      // No-op when either user_id or per-agent user_memory config is absent.
      const userMemoryStore = this.getUserMemoryStore(agent);
      let injectedUserMemories: UserMemory[] = [];
      if (userId && userMemoryStore) {
        const cfg = agent.memory!.user_memory!;
        const limit = cfg.inject_limit ?? 10;
        try {
          injectedUserMemories = await userMemoryStore.search(userId, guardedInput, limit);
        } catch (err) {
          // User-memory failures are non-fatal — log and continue with
          // an empty memory set rather than aborting the whole run.
          logger.warn(
            { error: err instanceof Error ? err.message : String(err), agent: agent.name, user_id: userId },
            "User-memory search failed — continuing without injected memories",
          );
        }
        if (injectedUserMemories.length > 0) {
          baseSystemPrompt += "\n\nWhat I remember about you:\n" +
            injectedUserMemories
              .map((m) => "- " + m.content + " [importance: " + importanceLabel(m.importance) + "]")
              .join("\n");
        }
      }

      // Agentic loop. The try/catch around it only exists to surface the
      // last durable checkpoint on crash — the error itself still
      // propagates so callers see the real failure.
      try {
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
        let systemPrompt = baseSystemPrompt;
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

        const response = await Tracing.llmCall(
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
          ...(userId !== undefined ? { user_id: userId } : {}),
        };

        // Attach user-memory helpers when both the agent has user_memory
        // configured and the run was started with a user_id. The bound
        // userId is implicit — tool code does not pass it on every call.
        // Defaults to importance: 3 (high) since explicit `remember()`
        // calls from tool code reflect deliberate intent.
        if (userId && userMemoryStore) {
          const store = userMemoryStore;
          toolContext.user_memory = {
            remember: async (content, options) => {
              const stored = await store.store(userId, content, {
                source: "explicit",
                importance: options?.importance ?? 3,
                ...(options?.tags !== undefined ? { tags: options.tags } : {}),
                ...(options?.expires_at !== undefined ? { expires_at: options.expires_at } : {}),
              });
              return { id: stored.id };
            },
          };
        }

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
              agent.requireApproval,
            ),
          ),
        );

        // Add tool results as a user message (Anthropic API format)
        messages.push({ role: "user", content: toolResults });

        // Durable checkpoint at the bottom of the tool-use branch: the
        // turn is fully processed (assistant message + tool_results both
        // persisted to `messages`) and we're about to ask the LLM to act
        // on those results. This is the natural "safe to resume from"
        // boundary — state.awaiting_tool_results=true flags exactly that.
        if (durableEnabled && this.checkpointStore) {
          const cp: Checkpoint = {
            session_id: session.id,
            turn: turns,
            messages: [...messages],
            tool_results: toolResults.map((r) => ({
              content: r.content,
              ...(r.is_error ? { is_error: r.is_error } : {}),
            })),
            state: {
              next_turn: turns + 1,
              prompt_tokens_used: totalUsage.input_tokens,
              completion_tokens_used: totalUsage.output_tokens,
              awaiting_tool_results: true,
            },
            saved_at: new Date(),
          };
          try {
            const store = this.checkpointStore;
            await Tracing.checkpoint(session.id, turns, () => store.save(cp));
            lastCheckpointedTurn = turns;
            this.events.emit({
              type: "checkpoint:saved",
              session_id: session.id,
              turn: turns,
            });
          } catch (err) {
            // Durability is best-effort — a transient Redis / Postgres
            // outage shouldn't abort the agent run. Log loudly so the
            // operator sees it; the next turn will retry.
            logger.error(
              {
                agent: agent.name,
                session: session.id,
                turn: turns,
                error: err instanceof Error ? err.message : String(err),
              },
              "Checkpoint save failed — continuing without durability for this turn",
            );
          }
        }
      }

      } catch (err) {
        if (durableEnabled) {
          logger.error(
            {
              agent: agent.name,
              session: session.id,
              last_checkpointed_turn: lastCheckpointedTurn,
              error: err instanceof Error ? err.message : String(err),
            },
            lastCheckpointedTurn >= 0
              ? "Agent run crashed; resume is available from the last checkpoint"
              : "Agent run crashed before any checkpoint was written",
          );
        }
        throw err;
      }

      // Extract final text output
      let output = extractText(
        messages.filter((m) => m.role === "assistant").at(-1)?.content,
      );

      // Structured output validation + retry loop
      let structuredResult: unknown = undefined;
      if (agent.outputSchema) {
        const maxRetries = agent.maxRetries ?? DEFAULT_STRUCTURED_OUTPUT_MAX_RETRIES;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const parsed: unknown = JSON.parse(output);
            structuredResult = agent.outputSchema.parse(parsed);
            break;
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);

            if (attempt >= maxRetries) {
              throw new StructuredOutputError(output, errorMsg);
            }

            logger.warn(
              { agent: agent.name, attempt: attempt + 1, error: errorMsg },
              "Structured output validation failed, retrying",
            );

            messages.push({
              role: "user",
              content: `Your response was invalid JSON. Error: ${errorMsg}. Try again.`,
            });

            turns++;

            const retryRequest: ChatRequest = {
              model: agent.model,
              system: baseSystemPrompt,
              messages,
            };

            const retryResponse = await withRetry(() =>
              agent.streaming
                ? this.streamToResponse(agent.name, retryRequest)
                : this.provider.chat(retryRequest),
            );

            totalUsage.input_tokens += retryResponse.usage.input_tokens;
            totalUsage.output_tokens += retryResponse.usage.output_tokens;
            messages.push({ role: "assistant", content: retryResponse.content });

            output = extractText(retryResponse.content);
          }
        }
      }

      // Output guardrail — may modify or block the output after the last turn.
      if (agent.afterRun) {
        const afterRun = agent.afterRun;
        const result = await Tracing.guardrail(
          "afterRun",
          () => Promise.resolve(afterRun(output, runCtx)),
          (r) => (typeof r === "string" ? "redact" : "pass"),
        );
        if (typeof result === "string") {
          output = result;
        }
      }

      // Persist updated messages
      this.sessions.update(session.id, messages);

      logger.info(
        { agent: agent.name, session: session.id, turns, usage: totalUsage },
        "Agent finished",
      );

      this.events.emit({
        type: "agent:end",
        agent_name: agent.name,
        session_id: session.id,
      });

      const trace_id = getCurrentTraceId();
      // Aggregate per-call cost recorded on llm.completion spans into a
      // single per-run figure. Null when no span had a known model price
      // (e.g. fully custom model with no registerModelPrice call).
      const runCost = trace_id !== undefined ? getRunCost(trace_id).cost_usd : null;
      const usage: TokenUsage = {
        ...totalUsage,
        ...(runCost !== null ? { cost_usd: runCost } : {}),
      };
      const agentResult: AgentResult = {
        session_id: session.id,
        output,
        messages,
        turns,
        usage,
        ...(structuredResult !== undefined ? { structured: structuredResult } : {}),
        ...(trace_id !== undefined ? { trace_id } : {}),
      };

      // afterAgentRun hooks
      await this.safeHook(() => this.globalHooks?.afterAgentRun?.(hookCtx, agentResult));
      await this.safeHook(() => agentHooks?.afterAgentRun?.(hookCtx, agentResult));

      // Auto-infer user memories from the conversation when enabled. Best
      // effort — failures are logged and swallowed so a flaky inference
      // pass never breaks the run for the caller.
      if (
        userId &&
        userMemoryStore &&
        agent.memory?.user_memory?.auto_infer === true
      ) {
        await this.inferAndStoreUserMemories(
          agent,
          userId,
          messages,
          userMemoryStore,
        );
      }

      return agentResult;
    });
  }

  /**
   * Send the last few turns of the conversation to the LLM with an
   * extraction prompt and store any returned facts as `inferred` memories.
   *
   * Best-effort: parsing failures, malformed responses, and provider
   * errors are all logged and swallowed. Auto-infer must never abort
   * the wider run.
   */
  private async inferAndStoreUserMemories(
    agent: AgentConfig,
    userId: string,
    messages: ChatMessage[],
    store: UserMemoryStore,
  ): Promise<void> {
    // Last 5 turns ≈ last 10 messages (one user + one assistant per turn).
    // We don't try to be precise — the LLM does not need exact framing.
    const recent = messages.slice(-10);
    if (recent.length === 0) return;

    const extractionPrompt =
      "Extract 0–3 new factual memories about the user from this conversation. " +
      "Return a JSON array of strings. Each string must be a single sentence " +
      "starting with 'User'. Return [] if nothing new was learned.";

    let response: ChatResponse;
    try {
      response = await this.provider.chat({
        model: agent.model,
        system: extractionPrompt,
        messages: recent,
      });
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), agent: agent.name },
        "User-memory auto-infer LLM call failed — skipping inference",
      );
      return;
    }

    const text = extractText(response.content).trim();
    const facts = parseInferredMemories(text);
    if (facts.length === 0) return;

    for (const content of facts) {
      try {
        const opts: StoreOptions = { source: "inferred", importance: 2 };
        await store.store(userId, content, opts);
      } catch (err) {
        logger.warn(
          {
            error: err instanceof Error ? err.message : String(err),
            agent: agent.name,
            user_id: userId,
          },
          "User-memory auto-infer store failed for one fact",
        );
      }
    }
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
    requireApproval?: AgentConfig["requireApproval"],
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
    return Tracing.toolCall(block.name, block.input, async () => {
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

        // Human-in-the-loop approval gate. Runs AFTER Zod validation
        // (so the stored tool_args are the parsed shape reviewers will
        // see) and BEFORE cache lookup (so a cached result doesn't
        // bypass review). Denial throws InterruptDeniedError which
        // propagates up and aborts the run.
        if (needsApproval(requireApproval, block.name, tool.destructive)) {
          await this.awaitApproval(context.session_id, block.name, parsed);
        }

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
        // Approval denials are intentional, operator-driven signals to
        // abort the run — they must propagate rather than be swallowed
        // into a tool_result error that the LLM could silently ignore.
        if (error instanceof InterruptDeniedError) throw error;

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

/** Render a UserMemoryImportance literal as a human-readable label. */
function importanceLabel(importance: 1 | 2 | 3): string {
  if (importance === 3) return "high";
  if (importance === 1) return "low";
  return "normal";
}

/**
 * Parse the LLM's auto-infer response. Tolerates code-fenced JSON, prose
 * around the array, and accidentally-doubled wrappers — the LLM does not
 * always cooperate. Returns an empty array on any parse error rather
 * than throwing; auto-infer is best-effort.
 */
function parseInferredMemories(text: string): string[] {
  if (text === "") return [];
  // Strip a single leading/trailing code fence if present.
  let body = text.trim();
  const fence = /^```(?:json)?\n?([\s\S]*?)\n?```$/;
  const match = fence.exec(body);
  if (match) body = match[1].trim();

  // Find the first '[' and the matching last ']' — robust to leading prose.
  const first = body.indexOf("[");
  const last = body.lastIndexOf("]");
  if (first === -1 || last === -1 || last < first) return [];
  const sliced = body.slice(first, last + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(sliced);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
