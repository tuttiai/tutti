/**
 * The agent loop.
 *
 * One iteration is a turn: enforce budgets, build the request, call the
 * provider, account for usage, then either finish or dispatch the tool calls
 * the model asked for and checkpoint the result.
 *
 * The loop owns no state of its own — everything it touches arrives in
 * {@link RunLoopState} (mutated in place), {@link RunLoopContext} (fixed for
 * the run) or {@link RunLoopDeps} (the runner's collaborators). That is what
 * lets it live outside `AgentRunner`.
 */

import type {
  ChatRequest,
  ToolContext,
  ToolResultBlock,
  ToolUseBlock,
} from "@tuttiai/types";
import { estimateCost } from "@tuttiai/telemetry";
import type { Checkpoint } from "../checkpoint/index.js";
import { createMemoryHelpers } from "../memory/curated.js";
import { BudgetExceededError } from "../errors.js";
import { logger } from "../logger.js";
import { Tracing, setActiveLlmAttributes } from "../telemetry.js";
import { checkCostBudgetBreach, costBudgetChecks } from "./budget.js";
import { withRetry } from "./retry.js";
import type { RunLoopContext, RunLoopDeps, RunLoopState } from "./state.js";

/** Default per-tool timeout when the agent does not set `tool_timeout_ms`. */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * Run the agent loop to completion.
 *
 * Exits when the model stops requesting tools, when `maxTurns` is reached,
 * when the tool-call ceiling is breached, or when a token budget is exhausted.
 * A cost-budget breach throws {@link BudgetExceededError} rather than breaking,
 * so a caller cannot keep paying for an over-cap run.
 *
 * `state` is mutated in place; the caller reads the final turn count, usage and
 * messages from it after this resolves.
 *
 * @param state - The run's mutable state.
 * @param ctx - Everything fixed for the run's duration.
 * @param deps - The runner's collaborators.
 * @throws {BudgetExceededError} When a per-run, daily or monthly cost cap is breached.
 */
export async function runAgentLoop(
  state: RunLoopState,
  ctx: RunLoopContext,
  deps: RunLoopDeps,
): Promise<void> {
  while (state.turns < ctx.maxTurns) {
    state.turns++;

    // Pre-call hard enforcement on cost budgets. Catches "previous
    // turn just pushed us over" and "we started the run already
    // past today's cap" without making another paid call. Token-
    // based limits keep their soft-break semantics below.
    if (ctx.budget && ctx.cfg) {
      const breach = checkCostBudgetBreach(
        ctx.cfg,
        ctx.budget.estimated_cost_usd,
        ctx.dailySnapshotUsd,
        ctx.monthlySnapshotUsd,
      );
      if (breach) {
        deps.events.emit({
          type: "budget:exceeded",
          agent_name: ctx.agent.name,
          tokens: ctx.budget.total_tokens,
          cost_usd: ctx.budget.estimated_cost_usd,
          scope: breach.scope,
          limit: breach.limit,
        });
        throw new BudgetExceededError({
          scope: breach.scope,
          limit: breach.limit,
          current: breach.current,
          tokens: ctx.budget.total_tokens,
        });
      }
    }

    logger.info({ agent: ctx.agent.name, session: ctx.session.id, turn: state.turns }, "Turn started");

    deps.events.emit({
      type: "turn:start",
      agent_name: ctx.agent.name,
      session_id: ctx.session.id,
      turn: state.turns,
    });

    // Inject semantic memories into system prompt if enabled.
    // Uses the per-ctx.agent-resolved store so a custom
    // `ctx.agent.memory.semantic.store` is honoured here too.
    let systemPrompt = ctx.baseSystemPrompt;
    const memCfg = ctx.semanticCfg;
    if (memCfg?.enabled && ctx.semanticStore) {
      const maxMemories = memCfg.max_memories ?? 5;
      const injectSystem = memCfg.inject_system !== false;
      if (injectSystem) {
        const memories = await ctx.semanticStore.search(
          ctx.input,
          ctx.agent.name,
          maxMemories,
        );
        if (memories.length > 0) {
          const memoryBlock = memories
            .map((m) => `- ${m.content}`)
            .join("\n");
          systemPrompt +=
            "\n\nRelevant context from previous sessions:\n" +
            memoryBlock;
          // When the curated tools are also active, hint that the
          // model may call them to extend or correct this context.
          if (memCfg.curated_tools !== false) {
            systemPrompt +=
              "\n\nUse the `remember` tool when the user shares something worth keeping. " +
              "Use `recall` to look things up. " +
              "Use `forget` to remove an entry the user retracts.";
          }
        }
      }
    }

    let request: ChatRequest = {
      model: ctx.agent.model,
      system: systemPrompt,
      messages: state.messages,
      tools: ctx.toolDefs.length > 0 ? ctx.toolDefs : undefined,
    };

    // beforeLLMCall hooks — may modify the request
    ctx.hookCtx.turn = state.turns;
    const globalReq = await deps.safeHook(() => deps.globalHooks?.beforeLLMCall?.(ctx.hookCtx, request));
    if (globalReq) request = globalReq;
    const agentReq = await deps.safeHook(() => ctx.agentHooks?.beforeLLMCall?.(ctx.hookCtx, request));
    if (agentReq) request = agentReq;

    logger.debug({ agent: ctx.agent.name, model: ctx.agent.model }, "LLM request");

    deps.events.emit({
      type: "llm:request",
      agent_name: ctx.agent.name,
      request,
    });

    const response = await Tracing.llmCall(
      ctx.agent.model ?? "unknown",
      async () => {
        const r = await withRetry(() =>
          ctx.agent.streaming
            ? deps.streamToResponse(ctx.routerScope, request)
            : deps.callProviderChat(ctx.routerScope, request, ctx.budget),
        );
        // For `model: 'auto'`, mirror the SmartProvider's chosen
        // model onto the still-open span and recompute cost at the
        // resolved tier's rate. Without this, the span carries
        // `model: 'auto'` (no PRICING entry → cost_usd missing),
        // which would silently break run-cost-store accounting.
        if (ctx.agent.model === "auto") {
          const sp = deps.asSmartProvider();
          const resolved = sp?.getLastDecision?.()?.model;
          if (resolved) {
            const cost = estimateCost(
              resolved,
              r.usage.input_tokens,
              r.usage.output_tokens,
            );
            setActiveLlmAttributes({
              auto_routed: true,
              model: resolved,
              ...(cost !== null ? { cost_usd: cost } : {}),
            });
          } else {
            setActiveLlmAttributes({ auto_routed: true });
          }
        }
        return r;
      },
    );

    logger.debug(
      { agent: ctx.agent.name, stopReason: response.stop_reason, usage: response.usage },
      "LLM response",
    );

    deps.events.emit({
      type: "llm:response",
      agent_name: ctx.agent.name,
      response,
    });

    // afterLLMCall hooks
    await deps.safeHook(() => deps.globalHooks?.afterLLMCall?.(ctx.hookCtx, response));
    await deps.safeHook(() => ctx.agentHooks?.afterLLMCall?.(ctx.hookCtx, response));

    state.totalUsage.input_tokens += response.usage.input_tokens;
    state.totalUsage.output_tokens += response.usage.output_tokens;

    // For `model: 'auto'` runs, price this call at the SmartProvider's
    // chosen tier rather than the 'auto' sentinel (which has no
    // PRICING entry). Span attribution already happened inside the
    // llmCall callback above.
    const resolvedModel =
      ctx.agent.model === "auto"
        ? deps.asSmartProvider()?.getLastDecision?.()?.model
        : undefined;

    // Check ctx.budget. Token limits keep their soft-break semantics
    // (event + return partial result). Cost limits — per-run,
    // daily, monthly — emit warning at the configured threshold and
    // hard-throw on breach so callers cannot keep paying for an
    // over-cap run.
    if (ctx.budget) {
      ctx.budget.add(
        response.usage.input_tokens,
        response.usage.output_tokens,
        resolvedModel,
      );

      // Token-based path: preserves the historical event-and-break
      // behaviour the integration tests assert.
      if (ctx.cfg?.max_tokens && ctx.budget.total_tokens >= ctx.cfg.max_tokens) {
        logger.warn(
          { agent: ctx.agent.name, tokens: ctx.budget.total_tokens, cost_usd: ctx.budget.estimated_cost_usd },
          "Token ctx.budget exceeded",
        );
        deps.events.emit({
          type: "budget:exceeded",
          agent_name: ctx.agent.name,
          tokens: ctx.budget.total_tokens,
          cost_usd: ctx.budget.estimated_cost_usd,
        });
        state.messages.push({ role: "assistant", content: response.content });
        break;
      }
      if (ctx.cfg?.max_tokens) {
        const warnAt = (ctx.cfg.warn_at_percent ?? 80) / 100;
        if (ctx.budget.total_tokens >= ctx.cfg.max_tokens * warnAt) {
          deps.events.emit({
            type: "budget:warning",
            agent_name: ctx.agent.name,
            tokens: ctx.budget.total_tokens,
            cost_usd: ctx.budget.estimated_cost_usd,
          });
        }
      }

      // Cost-based path: per-scope warnings + hard throw on breach.
      if (ctx.cfg) {
        const checks = costBudgetChecks(
          ctx.cfg,
          ctx.budget.estimated_cost_usd,
          ctx.dailySnapshotUsd,
          ctx.monthlySnapshotUsd,
        );
        const warnAt = (ctx.cfg.warn_at_percent ?? 80) / 100;
        for (const c of checks) {
          if (c.current >= c.limit) {
            logger.warn(
              {
                agent: ctx.agent.name,
                scope: c.scope,
                current: c.current,
                limit: c.limit,
              },
              "Cost ctx.budget exceeded",
            );
            deps.events.emit({
              type: "budget:exceeded",
              agent_name: ctx.agent.name,
              tokens: ctx.budget.total_tokens,
              cost_usd: ctx.budget.estimated_cost_usd,
              scope: c.scope,
              limit: c.limit,
            });
            state.messages.push({ role: "assistant", content: response.content });
            throw new BudgetExceededError({
              scope: c.scope,
              limit: c.limit,
              current: c.current,
              tokens: ctx.budget.total_tokens,
            });
          }
          if (c.current >= c.limit * warnAt) {
            deps.events.emit({
              type: "budget:warning",
              agent_name: ctx.agent.name,
              tokens: ctx.budget.total_tokens,
              cost_usd: ctx.budget.estimated_cost_usd,
              scope: c.scope,
              limit: c.limit,
            });
          }
        }
      }
    }

    // Add assistant message
    state.messages.push({ role: "assistant", content: response.content });

    deps.events.emit({
      type: "turn:end",
      agent_name: ctx.agent.name,
      session_id: ctx.session.id,
      turn: state.turns,
    });

    // If the model is done talking, exit the loop
    if (response.stop_reason !== "tool_use") {
      break;
    }

    // Execute tool calls
    const toolUseBlocks = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );

    state.totalToolCalls += toolUseBlocks.length;
    if (state.totalToolCalls > ctx.maxToolCalls) {
      state.messages.push({
        role: "user",
        content: toolUseBlocks.map((block) => ({
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: `Tool call rate limit exceeded: ${state.totalToolCalls} calls (max: ${ctx.maxToolCalls})`,
          is_error: true,
        })),
      });
      break;
    }

    const toolTimeoutMs = ctx.agent.tool_timeout_ms ?? DEFAULT_TOOL_TIMEOUT_MS;
    const toolContext: ToolContext = {
      session_id: ctx.session.id,
      agent_name: ctx.agent.name,
      ...(ctx.userId !== undefined ? { user_id: ctx.userId } : {}),
    };

    // Attach user-memory helpers when both the ctx.agent has user_memory
    // configured and the run was started with a user_id. The bound
    // ctx.userId is implicit — tool code does not pass it on every call.
    // Defaults to importance: 3 (high) since explicit `remember()`
    // calls from tool code reflect deliberate intent.
    if (ctx.userId && ctx.userMemory) {
      const userId = ctx.userId;
      const store = ctx.userMemory.store;
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

    // Attach memory helpers if semantic memory is enabled. Both
    // `ctx.memory` (for user-defined tool code) and the curated
    // `remember` / `recall` / `forget` ctx.agent tools route through
    // the same `MemoryEnforcer`, so cap, LRU eviction, and
    // `memory:*` events fire exactly once per logical operation.
    if (ctx.memoryEnforcer) {
      toolContext.memory = createMemoryHelpers(ctx.memoryEnforcer);
    }

    // Pass the audit array only when an observer is wired —
    // executeTool short-circuits the hash + push when undefined.
    const auditSink = deps.trajectoryObserver ? state.trajectoryAudit : undefined;
    const toolResults: ToolResultBlock[] = await Promise.all(
      toolUseBlocks.map((block) =>
        deps.executeTool(
          ctx.allTools,
          block,
          toolContext,
          toolTimeoutMs,
          ctx.hookCtx,
          ctx.agentHooks,
          ctx.agent.cache,
          ctx.agent.requireApproval,
          auditSink,
        ),
      ),
    );

    // Add tool results as a user message (Anthropic API format)
    state.messages.push({ role: "user", content: toolResults });

    // Durable checkpoint at the bottom of the tool-use branch: the
    // turn is fully processed (assistant message + tool_results both
    // persisted to `state.messages`) and we're about to ask the LLM to act
    // on those results. This is the natural "safe to resume from"
    // boundary — state.awaiting_tool_results=true flags exactly that.
    if (ctx.durableEnabled && deps.checkpointStore) {
      const cp: Checkpoint = {
        session_id: ctx.session.id,
        turn: state.turns,
        messages: [...state.messages],
        tool_results: toolResults.map((r) => ({
          content: r.content,
          ...(r.is_error ? { is_error: r.is_error } : {}),
        })),
        state: {
          next_turn: state.turns + 1,
          prompt_tokens_used: state.totalUsage.input_tokens,
          completion_tokens_used: state.totalUsage.output_tokens,
          awaiting_tool_results: true,
        },
        saved_at: new Date(),
      };
      try {
        const store = deps.checkpointStore;
        await Tracing.checkpoint(ctx.session.id, state.turns, () => store.save(cp));
        state.lastCheckpointedTurn = state.turns;
        deps.events.emit({
          type: "checkpoint:saved",
          session_id: ctx.session.id,
          turn: state.turns,
        });
      } catch (err) {
        // Durability is best-effort — a transient Redis / Postgres
        // outage shouldn't abort the ctx.agent run. Log loudly so the
        // operator sees it; the next turn will retry.
        logger.error(
          {
            agent: ctx.agent.name,
            session: ctx.session.id,
            turn: state.turns,
            error: err instanceof Error ? err.message : String(err),
          },
          "Checkpoint save failed — continuing without durability for this turn",
        );
      }
    }
  }
}
