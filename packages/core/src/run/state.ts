/**
 * The state contract for a run in progress.
 *
 * `AgentRunner.run()` used to hold all of this as locals inside one closure,
 * which is what made the agent loop impossible to lift out. Splitting it into
 * three explicit shapes — what mutates, what is fixed, and what is borrowed
 * from the runner — is what lets the loop live in its own module.
 *
 * The split is by lifetime, not by topic:
 *
 * - {@link RunLoopState} changes as the run progresses.
 * - {@link RunLoopContext} is resolved once at run start and never changes.
 * - {@link RunLoopDeps} is the runner's own collaborators, passed as callbacks
 *   so the loop never needs a reference to the runner itself.
 */

import type {
  AgentConfig,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  HookContext,
  Session,
  TokenUsage,
  Tool,
  ToolContext,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
  TuttiHooks,
  BudgetConfig,
} from "@tuttiai/types";
import type { TrajectoryToolCall } from "@tuttiai/skills";
import type { CheckpointStore } from "../checkpoint/index.js";
import type { EventBus } from "../event-bus.js";
import type { SemanticMemoryStore } from "../memory/semantic.js";
import type { MemoryEnforcer } from "../memory/curated.js";
import type { TrajectoryObserver } from "../skills/observer.js";
import type { TokenBudget } from "../token-budget.js";
import type { ResolvedUserMemory } from "./system-prompt.js";

/**
 * Per-call ALS scope carrying the routing context the `SmartProvider`'s
 * `on_decision` / `on_fallback` callbacks need to tag emitted events. Kept as
 * one object so adding fields stays cheap as the integration grows.
 */
export interface RouterScope {
  /** The agent whose call is being routed. */
  agent_name: string;
  /** How many destructive tools the agent has loaded — its blast radius. */
  destructive_tool_count: number;
}

/**
 * Subset of `@tuttiai/router`'s `SmartProvider` surface that the run pipeline
 * calls into. Declared structurally so `@tuttiai/core` does not depend on
 * `@tuttiai/router`, which would close a build cycle.
 */
export interface SmartProviderSurface {
  previewDecision: (
    request: ChatRequest,
    ctx?: { destructive_tool_count?: number },
  ) => Promise<{ estimated_cost_usd: number }>;
  chat: (
    request: ChatRequest,
    override?: { force_tier?: "small" | "medium" | "large" | "fallback"; force_reason?: string },
  ) => Promise<ChatResponse>;
  /**
   * Last routing decision the provider made on this process. Used after a call
   * to discover which model the SmartProvider actually picked — needed to
   * price `model: 'auto'` runs at the resolved tier and to mark the
   * `llm.completion` span. Optional: older fakes may omit it, and callers
   * degrade gracefully when it returns `undefined`.
   */
  getLastDecision?: () => { model: string } | undefined;
}

/** Everything about a run that changes as it progresses. */
export interface RunLoopState {
  /** Turns taken so far. */
  turns: number;
  /** Tool calls issued so far, across every turn. */
  totalToolCalls: number;
  /** Highest turn a checkpoint was successfully written for, or -1. */
  lastCheckpointedTurn: number;
  /** Token totals, accumulated in place across turns. */
  totalUsage: TokenUsage;
  /** The conversation. Appended to on every turn. */
  messages: ChatMessage[];
  /** One entry per tool execution, drained at run end by the observer. */
  trajectoryAudit: TrajectoryToolCall[];
}

/** Everything resolved once at run start and fixed for the run's duration. */
export interface RunLoopContext {
  /** The agent being run. */
  agent: AgentConfig;
  /** The session this run belongs to. */
  session: Session;
  /** The original user input, used as the semantic-memory search query. */
  input: string;
  /** Turn ceiling. */
  maxTurns: number;
  /** Tool-call ceiling. */
  maxToolCalls: number;
  /** Token budget tracker, when configured. */
  budget: TokenBudget | undefined;
  /** Cost limits, with unusable scopes already stripped. */
  cfg: BudgetConfig | undefined;
  /** Spend recorded today at run start. */
  dailySnapshotUsd: number;
  /** Spend recorded this month at run start. */
  monthlySnapshotUsd: number;
  /** Every tool the agent can call. */
  allTools: Tool[];
  /** Provider-facing definitions for {@link allTools}. */
  toolDefs: ToolDefinition[];
  /** The system prompt each turn starts from, before memory injection. */
  baseSystemPrompt: string;
  /** Routing scope for this run's provider calls. */
  routerScope: RouterScope;
  /** Hook context, whose `turn` field is updated per turn. */
  hookCtx: HookContext;
  /** The agent's own hooks, if any. */
  agentHooks: TuttiHooks | undefined;
  /** Whether this run checkpoints. */
  durableEnabled: boolean;
  /** Curated-memory enforcer, when semantic memory is enabled. */
  memoryEnforcer: MemoryEnforcer | undefined;
  /** The agent's semantic-memory config. */
  semanticCfg: NonNullable<AgentConfig["memory"]>["semantic"];
  /** The resolved semantic store. */
  semanticStore: SemanticMemoryStore | undefined;
  /** The user this run is attributed to. */
  userId: string | undefined;
  /** The agent's user-memory store and config. */
  userMemory: ResolvedUserMemory | undefined;
}

/**
 * The runner's collaborators, passed as plain values and callbacks so the loop
 * never holds a reference to `AgentRunner` itself.
 */
export interface RunLoopDeps {
  /** The event bus every turn publishes to. */
  events: EventBus;
  /** Runtime-wide hooks. */
  globalHooks: TuttiHooks | undefined;
  /** Checkpoint store, when durable runs are configured. */
  checkpointStore: CheckpointStore | undefined;
  /** Trajectory observer, when skills are enabled. */
  trajectoryObserver: TrajectoryObserver | undefined;
  /** Invoke a hook, swallowing and logging any failure. */
  safeHook: <T>(fn: (() => Promise<T> | T | undefined) | undefined) => Promise<T | undefined>;
  /** The configured provider, when it can route. */
  asSmartProvider: () => SmartProviderSurface | null;
  /** Issue a streaming provider call, collapsed into a single response. */
  streamToResponse: (scope: RouterScope, request: ChatRequest) => Promise<ChatResponse>;
  /** Issue a non-streaming provider call. */
  callProviderChat: (
    scope: RouterScope,
    request: ChatRequest,
    budget?: TokenBudget,
  ) => Promise<ChatResponse>;
  /** Execute one tool call. */
  executeTool: (
    tools: Tool[],
    block: ToolUseBlock,
    context: ToolContext,
    timeoutMs: number,
    hookCtx?: HookContext,
    agentHooks?: TuttiHooks,
    cacheCfg?: { enabled: boolean; ttl_ms?: number; excluded_tools?: string[] },
    requireApproval?: AgentConfig["requireApproval"],
    audit?: TrajectoryToolCall[],
  ) => Promise<ToolResultBlock>;
}
