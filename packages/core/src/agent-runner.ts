import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type {
  AgentConfig,
  AgentResult,
  AgentUserMemoryConfig,
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
  ToolResultBlock,
  ToolUseBlock,
  TokenUsage,
  TuttiHooks,
} from "@tuttiai/types";
import type { CheckpointStore } from "./checkpoint/index.js";
import type { EventBus } from "./event-bus.js";
import { SecretsManager } from "./secrets.js";
import { PromptGuard } from "./prompt-guard.js";
import { TokenBudget } from "./token-budget.js";
import type { SemanticMemoryStore } from "./memory/semantic.js";
import { createUserMemoryStore } from "./memory/user/index.js";
import { MemoryUserMemoryStore } from "./memory/user/memory-store.js";
import type {
  AgentRunOptions,
  StoreOptions,
  UserMemoryStore,
} from "./memory/user/types.js";
import {
  InMemoryUserModelStore,
  type UserModelStore,
} from "./memory/user-model.js";
import {
  UserModelConsolidator,
  type UserModelConsolidatorOptions,
} from "./memory/consolidator.js";
import type { TrajectoryObserver } from "./skills/observer.js";
import { hashToolInput } from "./skills/observer.js";
import type { SkillExecutor } from "./skills/executor.js";
import type { TrajectoryToolCall } from "@tuttiai/skills";
import type { ToolCache } from "./cache/tool-cache.js";
import { DEFAULT_WRITE_TOOLS } from "./cache/index.js";
import type { RunCostStore } from "@tuttiai/telemetry";
import { logger } from "./logger.js";
import { Tracing, setActiveLlmAttributes } from "./telemetry.js";
import type { InterruptRequest, InterruptStore } from "./interrupt/index.js";
import { needsApproval } from "./interrupt/index.js";
import {
  InterruptDeniedError,
  ToolTimeoutError,
} from "./errors.js";
import { extractText, parseInferredMemories } from "./run/helpers.js";
import { assertAutoModelSupported, resolveRunSession } from "./run/preflight.js";
import { prepareRunBudget } from "./run/budget.js";
import { assembleRunTools } from "./run/tool-assembly.js";
import { composeSystemPrompt } from "./run/system-prompt.js";
import { extractFinalOutput, resolveRunOutput } from "./run/output.js";
import { finaliseRunCost } from "./run/cost.js";
import { withRetry } from "./run/retry.js";
import { runAgentLoop } from "./run/loop.js";
import type { RouterScope, RunLoopState, SmartProviderSurface } from "./run/state.js";

/**
 * Shape of the decision payload `@tuttiai/router`'s `SmartProvider`
 * passes to its `on_decision` callback. Inlined here so `@tuttiai/core`
 * does not need to depend on `@tuttiai/router` (which would cycle).
 */
interface RouterDecisionPayload {
  tier: string;
  model: string;
  reason: string;
  classifier: string;
  estimated_input_tokens: number;
  estimated_cost_usd: number;
}

/** Mirror of `@tuttiai/router`'s on_fallback payload. */
interface RouterFallbackPayload {
  from_model: string;
  to_model: string;
  error: string;
}



const DEFAULT_HITL_TIMEOUT_S = 300;

const hitlRequestSchema = z.object({
  question: z.string().describe("The question to ask the human"),
  options: z.array(z.string()).optional().describe("If provided, the human picks one of these"),
  timeout_seconds: z.number().optional().describe("How long to wait before timing out (default 300)"),
});


export class AgentRunner {
  private pendingHitl = new Map<string, (answer: string) => void>();
  /**
   * Lazily-constructed user-memory stores keyed by agent name. One store
   * per agent so different agents can pick different backends. Tests
   * pre-populate via {@link setUserMemoryStore} to inject mocks.
   */
  private userMemoryStores = new Map<string, UserMemoryStore>();
  /**
   * Per-agent dialectic-user-model wiring. The consolidator is the live
   * object the runtime calls; the store is exposed alongside so the
   * runtime's profile-inject path and tests share one state surface.
   * Built lazily from `agent.memory.user_model` on first use.
   */
  private userModelWiring = new Map<
    string,
    { store: UserModelStore; consolidator: UserModelConsolidator }
  >();
  /**
   * Test-seam overrides for {@link UserModelStore}, keyed by agent name.
   * Set via {@link setUserModelStore} before a run; read by
   * {@link getUserModelConsolidator} when wiring the consolidator.
   */
  private userModelStoreOverrides = new Map<string, UserModelStore>();
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

  /**
   * Per-runner ALS scope used to thread routing context (agent name and
   * loaded destructive-tool count) from the call site down into the
   * `SmartProvider`'s decision/fallback callbacks. A class field would
   * race when two parallel agents share one runner.
   */
  private routerContext = new AsyncLocalStorage<RouterScope>();

  constructor(
    private provider: LLMProvider,
    private events: EventBus,
    private sessions: SessionStore,
    private semanticMemory?: SemanticMemoryStore,
    private globalHooks?: TuttiHooks,
    private toolCache?: ToolCache,
    private checkpointStore?: CheckpointStore,
    private interruptStore?: InterruptStore,
    private runCostStore?: RunCostStore,
    private trajectoryObserver?: TrajectoryObserver,
    private skillExecutor?: SkillExecutor,
  ) {
    this.installRouterEventHooks();
  }

  /**
   * Run `provider.chat` inside the ALS scope so `SmartProvider`'s
   * decision/fallback callbacks (installed in
   * {@link installRouterEventHooks}) can tag emitted events with the
   * correct routing context. Always called — the no-op cost is a single
   * `als.run` for non-router providers.
   *
   * When the provider is a `SmartProvider` and a {@link TokenBudget} is
   * supplied, this previews the routing decision first and forces the
   * `small` tier with `reason: "budget-forced"` if the projected cost
   * would push the run over `max_cost_usd`. Lets the runtime degrade
   * gracefully instead of waiting for the post-hoc `check()` to flip.
   */
  private callProviderChat(
    scope: RouterScope,
    request: ChatRequest,
    budget?: TokenBudget,
  ): Promise<ChatResponse> {
    return this.routerContext.run(scope, () => this.invokeChat(request, scope, budget));
  }

  private async invokeChat(
    request: ChatRequest,
    scope: RouterScope,
    budget: TokenBudget | undefined,
  ): Promise<ChatResponse> {
    const sp = this.asSmartProvider();
    if (!sp || !budget) return this.provider.chat(request);

    const preview = await sp.previewDecision(request, {
      destructive_tool_count: scope.destructive_tool_count,
    });
    if (!budget.canAfford(preview.estimated_cost_usd)) {
      return sp.chat(request, { force_tier: "small", force_reason: "budget-forced" });
    }
    return this.provider.chat(request);
  }

  /**
   * Return the active provider as a `SmartProvider` surface when its
   * `name` marker matches and the duck-typed methods exist; otherwise
   * `null`. Centralised so the router-aware paths agree on what
   * "smart" means without each duplicating the predicate.
   */
  private asSmartProvider(): SmartProviderSurface | null {
    const candidate = this.provider as {
      name?: string;
      previewDecision?: unknown;
      chat?: unknown;
    };
    if (
      candidate.name !== "smart-router" ||
      typeof candidate.previewDecision !== "function" ||
      typeof candidate.chat !== "function"
    ) {
      return null;
    }
    // Safe cast: the duck-type checks above prove the surface exists.
    return this.provider as unknown as SmartProviderSurface;
  }

  /**
   * Detect a `@tuttiai/router` `SmartProvider` via the public `name`
   * marker and chain wrappers around its `on_decision` /
   * `on_fallback` config callbacks so router events surface on the
   * standard EventBus. The user's existing callbacks (if any) keep
   * firing — we wrap, never replace.
   */
  private installRouterEventHooks(): void {
    const candidate = this.provider as {
      name?: string;
      config?: {
        on_decision?: (decision: RouterDecisionPayload) => void;
        on_fallback?: (info: RouterFallbackPayload) => void;
      };
    };
    if (candidate.name !== "smart-router" || !candidate.config) return;

    const cfg = candidate.config;
    const userOnDecision = cfg.on_decision;
    const userOnFallback = cfg.on_fallback;
    const events = this.events;
    const ctx = this.routerContext;

    cfg.on_decision = (decision) => {
      const scope = ctx.getStore();
      events.emit({
        type: "router:decision",
        agent_name: scope?.agent_name ?? "unknown",
        tier: decision.tier,
        model: decision.model,
        reason: decision.reason,
        classifier: decision.classifier,
        estimated_input_tokens: decision.estimated_input_tokens,
        estimated_cost_usd: decision.estimated_cost_usd,
        // Only attach the count when the runner is the source — keeps
        // the field absent for events emitted from outside any ALS scope.
        ...(scope ? { destructive_tool_count: scope.destructive_tool_count } : {}),
      });
      // Mirror onto the active llm.completion span (in-process + OTel).
      setActiveLlmAttributes({
        router_tier: decision.tier,
        router_model: decision.model,
        router_classifier: decision.classifier,
        router_reason: decision.reason,
        router_cost_estimate: decision.estimated_cost_usd,
      });
      userOnDecision?.(decision);
    };
    cfg.on_fallback = (info) => {
      const scope = ctx.getStore();
      events.emit({
        type: "router:fallback",
        agent_name: scope?.agent_name ?? "unknown",
        from_model: info.from_model,
        to_model: info.to_model,
        error: info.error,
      });
      setActiveLlmAttributes({
        router_fallback_from: info.from_model,
        router_fallback_to: info.to_model,
        router_fallback_error: info.error,
      });
      userOnFallback?.(info);
    };
  }

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
  private getUserMemoryStore(
    agent: AgentConfig,
  ): { store: UserMemoryStore; cfg: AgentUserMemoryConfig } | undefined {
    const cfg = agent.memory?.user_memory;
    if (!cfg) return undefined;
    let store = this.userMemoryStores.get(agent.name);
    if (!store) {
      store = createUserMemoryStore(cfg);
      this.userMemoryStores.set(agent.name, store);
    }
    return { store, cfg };
  }

  /**
   * Test seam — pre-register a user-model store for an agent. Used by
   * `TuttiRuntime.setUserModelStore` and unit tests that want to inject
   * a custom or shared store across runs.
   */
  setUserModelStore(agent_name: string, store: UserModelStore): void {
    this.userModelStoreOverrides.set(agent_name, store);
    // If a consolidator was already built with the default store, drop
    // it so the next run rebuilds against the override.
    this.userModelWiring.delete(agent_name);
  }

  /**
   * Resolve the dialectic-user-model wiring for an agent, constructing
   * it lazily from `agent.memory.user_model` on first use. Returns
   * `undefined` when the agent has no user-model configuration or it
   * is disabled. The consolidator pulls source signal from the same
   * agent's `user_memory` store; agents with `user_model` but no
   * `user_memory` get a no-op consolidator that bootstraps off an
   * empty memory list.
   */
  private getUserModelConsolidator(
    agent: AgentConfig,
  ): { store: UserModelStore; consolidator: UserModelConsolidator } | undefined {
    const cfg = agent.memory?.user_model;
    if (!cfg || cfg.enabled === false) return undefined;

    const cached = this.userModelWiring.get(agent.name);
    if (cached) return cached;

    const store =
      this.userModelStoreOverrides.get(agent.name) ?? new InMemoryUserModelStore();

    // The consolidator needs a UserMemoryStore as its source signal.
    // When the agent has no user_memory config we synthesise an empty
    // ephemeral store so the consolidator can still bootstrap a profile
    // from the conversation summaries it writes itself in future
    // iterations. Today it just returns nothing on the first pass.
    const memoryStore = this.getUserMemoryStore(agent)?.store
      ?? new MemoryUserMemoryStore();

    const opts: UserModelConsolidatorOptions = {
      ...(cfg.every_n_turns !== undefined ? { every_n_turns: cfg.every_n_turns } : {}),
      ...(cfg.consolidation_model !== undefined ? { model: cfg.consolidation_model } : {}),
      ...(cfg.recent_memory_limit !== undefined
        ? { recent_memory_limit: cfg.recent_memory_limit }
        : {}),
      events: this.events,
    };
    const consolidator = new UserModelConsolidator(
      store,
      memoryStore,
      this.provider,
      opts,
    );

    const wiring = { store, consolidator };
    this.userModelWiring.set(agent.name, wiring);
    return wiring;
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
    assertAutoModelSupported(agent, this.asSmartProvider() !== null);

    const { session, userId } = resolveRunSession(agent, session_id, options, this.sessions);

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

      const { allTools, toolDefs, runId, semanticStore, memoryEnforcer } =
        await assembleRunTools(agent, session.id, {
          semanticMemory: this.semanticMemory,
          skillExecutor: this.skillExecutor,
          events: this.events,
          createHitlTool: (a, s) => this.createHitlTool(a, s),
        });
      const semanticCfg = agent.memory?.semantic;
      // Counted once per run — neither voices nor HITL toggle mid-loop.
      // Threaded into the router ALS scope so emitted decisions can
      // attribute the agent's blast radius alongside the routing choice.
      const destructiveToolCount = allTools.filter((t) => t.destructive === true).length;
      const routerScope: RouterScope = {
        agent_name: agent.name,
        destructive_tool_count: destructiveToolCount,
      };

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

      const {
        maxTurns,
        maxToolCalls,
        budget,
        cfg,
        runStartedAt,
        dailySnapshotUsd,
        monthlySnapshotUsd,
      } = await prepareRunBudget(agent, this.runCostStore);

      const totalUsage: TokenUsage =
        resuming && checkpoint
          ? {
              input_tokens: checkpoint.state.prompt_tokens_used,
              output_tokens: checkpoint.state.completion_tokens_used,
            }
          : { input_tokens: 0, output_tokens: 0 };
      let turns = resuming && checkpoint ? checkpoint.turn : 0;
      // Trajectory audit: every successful or failed tool execution
      // appends one entry. Drained at run end into the
      // `TrajectoryObserver` (when wired). Skipped entirely when no
      // observer is attached — keeps the no-observer path zero-cost.
      const trajectoryAudit: TrajectoryToolCall[] = [];
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
      const userMemory = this.getUserMemoryStore(agent);
      const userModel = this.getUserModelConsolidator(agent);
      const { baseSystemPrompt } = await composeSystemPrompt(agent, {
        userId,
        guardedInput,
        userMemory,
        userModel,
      });

      // Agentic loop. The try/catch around it only exists to surface the
      // last durable checkpoint on crash — the error itself still
      // propagates so callers see the real failure.
      try {
      // Agentic loop
      const loopState: RunLoopState = {
        turns,
        totalToolCalls: 0,
        lastCheckpointedTurn,
        totalUsage,
        messages,
        trajectoryAudit,
      };
      await runAgentLoop(
        loopState,
        {
          agent,
          session,
          input,
          maxTurns,
          maxToolCalls,
          budget,
          cfg,
          dailySnapshotUsd,
          monthlySnapshotUsd,
          allTools,
          toolDefs,
          baseSystemPrompt,
          routerScope,
          hookCtx,
          agentHooks,
          durableEnabled,
          memoryEnforcer,
          semanticCfg,
          semanticStore,
          userId,
          userMemory,
        },
        {
          events: this.events,
          globalHooks: this.globalHooks,
          checkpointStore: this.checkpointStore,
          trajectoryObserver: this.trajectoryObserver,
          safeHook: (fn) => this.safeHook(fn),
          asSmartProvider: () => this.asSmartProvider(),
          streamToResponse: (scope, request) => this.streamToResponse(scope, request),
          callProviderChat: (scope, request, b) => this.callProviderChat(scope, request, b),
          executeTool: (...args) => this.executeTool(...args),
        },
      );
      turns = loopState.turns;
      lastCheckpointedTurn = loopState.lastCheckpointedTurn;

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

      // Repair turns mutate the counter in place, so `turns` stays accurate
      // for the result and the run:end event.
      const outputCounter = { turns };
      const resolved = await resolveRunOutput(
        agent,
        extractFinalOutput(messages),
        {
          messages,
          baseSystemPrompt,
          totalUsage,
          callModel: (request) =>
            withRetry(() =>
              agent.streaming
                ? this.streamToResponse(routerScope, request)
                : this.callProviderChat(routerScope, request, budget),
            ),
        },
        outputCounter,
      );
      turns = outputCounter.turns;
      const structuredResult = resolved.structuredResult;
      // Reassigned below when the afterRun guardrail rewrites the output.
      let output = resolved.output;

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

      const { trace_id, usage } = await finaliseRunCost(agent, {
        sessionId: session.id,
        totalUsage,
        budget,
        runStartedAt,
        runCostStore: this.runCostStore,
      });

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
      if (userId && userMemory && userMemory.cfg.auto_infer === true) {
        await this.inferAndStoreUserMemories(
          agent,
          userId,
          messages,
          userMemory.store,
        );
      }

      // Fire-and-forget consolidation of the dialectic user profile.
      // We do NOT await — the caller's run latency is bounded by the
      // turn loop, not by the (possibly slow) consolidation LLM call.
      // The consolidator catches every error internally so dangling
      // promises never reach the unhandledRejection handler.
      if (userId && userModel) {
        void userModel.consolidator.maybeConsolidate(userId, turns);
      }

      // Fire-and-forget skill-trajectory recording. Same fire-and-forget
      // contract as the consolidator above — the observer catches every
      // error internally. Output is the final text of the agent's last
      // assistant turn, when one exists.
      if (this.trajectoryObserver) {
        void this.trajectoryObserver.observe({
          run_id: runId,
          agent_name: agent.name,
          ...(userId !== undefined ? { user_id: userId } : {}),
          started_at: runStartedAt,
          ended_at: new Date(),
          tool_calls: trajectoryAudit,
          ...(output !== "" ? { final_message: output } : {}),
        });
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
      response = await this.callProviderChat(
        { agent_name: agent.name, destructive_tool_count: 0 },
        {
          model: agent.model,
          system: extractionPrompt,
          messages: recent,
        },
      );
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
    scope: RouterScope,
    request: ChatRequest,
  ): Promise<ChatResponse> {
    return this.routerContext.run(scope, async () => {
      return this.streamToResponseInner(scope.agent_name, request);
    });
  }

  private async streamToResponseInner(
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
    audit?: TrajectoryToolCall[],
  ): Promise<ToolResultBlock> {
    const tool = tools.find((t) => t.name === block.name);
    if (!tool) {
      const available = tools.map((t) => t.name).join(", ") || "(none)";
      // Tool-not-found is a structural failure — record it so the
      // synthesiser can downweight trajectories where the model
      // hallucinates tool names.
      if (audit) {
        audit.push({
          tool: block.name,
          input_hash: hashToolInput(block.input),
          succeeded: false,
          duration_ms: 0,
        });
      }
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
      // Audit timing/hash captured once per call; the closure-scoped
      // `pushAudit` is a no-op when no observer is attached.
      const auditStart = audit ? Date.now() : 0;
      const auditHash = audit ? hashToolInput(block.input) : "";
      const pushAudit = (succeeded: boolean): void => {
        if (audit) {
          audit.push({
            tool: block.name,
            input_hash: auditHash,
            succeeded,
            duration_ms: Date.now() - auditStart,
          });
        }
      };

      // beforeToolCall hooks — return false to block, or modified input
      if (hookCtx) {
        const globalResult = await this.safeHook(() => this.globalHooks?.beforeToolCall?.(hookCtx, block.name, block.input));
        if (globalResult === false) {
          pushAudit(false);
          return { type: "tool_result" as const, tool_use_id: block.id, content: "Tool call blocked by hook", is_error: true };
        }
        const agentResult = await this.safeHook(() => agentHooks?.beforeToolCall?.(hookCtx, block.name, block.input));
        if (agentResult === false) {
          pushAudit(false);
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
            pushAudit(cached.is_error !== true);
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

        pushAudit(result.is_error !== true);
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
        if (error instanceof InterruptDeniedError) {
          pushAudit(false);
          throw error;
        }

        const message = error instanceof Error ? error.message : String(error);

        logger.error({ error: message, tool: block.name }, "Tool failed");

        this.events.emit({
          type: "tool:error",
          agent_name: context.agent_name,
          tool_name: block.name,
          error: error instanceof Error ? error : new Error(message),
        });

        pushAudit(false);
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
