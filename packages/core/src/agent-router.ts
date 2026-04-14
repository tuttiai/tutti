import { z } from "zod";
import type {
  AgentResult,
  ParallelAgentResult,
  ParallelEntryConfig,
  ScoreConfig,
  TokenUsage,
  Tool,
  Voice,
} from "@tuttiai/types";
import { TuttiRuntime } from "./runtime.js";
import type { EventBus } from "./event-bus.js";

/** Safe lookup into score.agents by dynamic key. */
function getAgent(
  agents: ScoreConfig["agents"],
  id: string,
): ScoreConfig["agents"][string] | undefined {
  const map = new Map(Object.entries(agents));
  return map.get(id);
}

// Sonnet-class fallback pricing (per million tokens) — matches eval runner.
const DEFAULT_INPUT_PER_M = 3;
const DEFAULT_OUTPUT_PER_M = 15;

/**
 * Type-guard: is this entry config the declarative parallel form?
 */
function isParallelEntry(
  entry: string | ParallelEntryConfig | undefined,
): entry is ParallelEntryConfig {
  return (
    typeof entry === "object" && entry !== null && entry.type === "parallel"
  );
}

/**
 * Estimate cost in USD for a given token usage. Uses Sonnet-class pricing
 * as a neutral default — callers needing strict accounting should consult
 * {@link TokenBudget} with a configured model.
 */
function estimateCostUsd(usage: TokenUsage): number {
  return (
    (usage.input_tokens / 1_000_000) * DEFAULT_INPUT_PER_M +
    (usage.output_tokens / 1_000_000) * DEFAULT_OUTPUT_PER_M
  );
}

/**
 * AgentRouter wraps TuttiRuntime and adds multi-agent orchestration.
 *
 * Two orchestration modes are supported:
 * - **Delegation** (default): the entry agent is an orchestrator with a
 *   `delegates[]` array; a `delegate_to_agent` tool is auto-injected so it
 *   can route to specialists sequentially.
 * - **Parallel fan-out**: the entry is a {@link ParallelEntryConfig}; calling
 *   `run(input)` dispatches the same input to every listed agent
 *   simultaneously and returns a merged {@link AgentResult}. For richer
 *   per-agent results, call {@link AgentRouter.runParallel} directly.
 */
export class AgentRouter {
  private runtime: TuttiRuntime;
  private parallelEntry: ParallelEntryConfig | null;

  constructor(private _score: ScoreConfig) {
    const entry = _score.entry;

    if (isParallelEntry(entry)) {
      // Parallel mode — no single orchestrator to enhance. Validate agents.
      if (entry.agents.length === 0) {
        throw new Error(
          "Parallel entry requires at least one agent in agents[].",
        );
      }
      const available = Object.keys(_score.agents);
      for (const id of entry.agents) {
        if (!getAgent(_score.agents, id)) {
          throw new Error(
            `Parallel entry agent "${id}" not found. Available: ${available.join(", ")}`,
          );
        }
      }
      this.parallelEntry = entry;
      this.runtime = new TuttiRuntime(_score);
      return;
    }

    // Build a modified score where the entry agent has the delegate tool
    const entryId = entry ?? "orchestrator";
    const entryAgent = getAgent(_score.agents, entryId);

    if (!entryAgent) {
      const available = Object.keys(_score.agents).join(", ");
      throw new Error(
        `Entry agent "${entryId}" not found. Available agents: ${available}`,
      );
    }

    if (!entryAgent.delegates || entryAgent.delegates.length === 0) {
      throw new Error(
        `Entry agent "${entryId}" has no delegates. Add a delegates[] array to enable routing.`,
      );
    }

    // Validate all delegate IDs exist
    for (const delegateId of entryAgent.delegates) {
      if (!getAgent(_score.agents, delegateId)) {
        throw new Error(
          `Delegate "${delegateId}" not found in agents. Available: ${Object.keys(_score.agents).join(", ")}`,
        );
      }
    }

    // Create the runtime with the modified score
    const modifiedScore = this.buildRoutingScore(_score, entryId);
    this.runtime = new TuttiRuntime(modifiedScore);
    this.parallelEntry = null;
  }

  /** EventBus from the underlying runtime — subscribe to all events. */
  get events(): EventBus {
    return this.runtime.events;
  }

  /**
   * Send input to the entry point. In delegation mode this runs the
   * orchestrator, which may delegate to specialists. In parallel mode this
   * fans the input out to every configured agent simultaneously and returns
   * a merged {@link AgentResult}; call {@link AgentRouter.runParallel} to
   * inspect per-agent results.
   */
  async run(input: string, session_id?: string): Promise<AgentResult> {
    if (this.parallelEntry) {
      const inputs = this.parallelEntry.agents.map((agent_id) => ({
        agent_id,
        input,
      }));
      const aggregate = await this.runParallelInternal(inputs, {});
      return this.mergeToAgentResult(aggregate);
    }

    const entryId =
      typeof this._score.entry === "string"
        ? this._score.entry
        : "orchestrator";
    return this.runtime.run(entryId, input, session_id);
  }

  /**
   * Run multiple agents simultaneously with independent sessions.
   *
   * Each agent gets its own session — no shared state. All agents are
   * started at once via `Promise.all`; if one rejects the others still
   * complete, and the failure is surfaced as a synthetic error result in
   * the returned map (so callers can see which agent broke).
   *
   * @param inputs - Pairs of `agent_id` and the input to send to that agent.
   * @param options - `timeout_ms` caps wall-clock time for any single agent.
   * @returns A map keyed by `agent_id` containing each agent's {@link AgentResult}.
   *
   * @example
   *   const map = await router.runParallel([
   *     { agent_id: "bull",  input: "Is AAPL a buy?" },
   *     { agent_id: "bear",  input: "Is AAPL a buy?" },
   *   ], { timeout_ms: 30_000 });
   */
  async runParallel(
    inputs: { agent_id: string; input: string }[],
    options?: { timeout_ms?: number },
  ): Promise<Map<string, AgentResult>> {
    const aggregate = await this.runParallelInternal(inputs, options ?? {});
    return aggregate.results;
  }

  /**
   * Lower-level parallel runner that returns the full {@link ParallelAgentResult}
   * aggregate (map + rollup metrics). Intended for callers who need the
   * merged output, total cost, or total duration alongside the per-agent map.
   */
  async runParallelWithSummary(
    inputs: { agent_id: string; input: string }[],
    options?: { timeout_ms?: number },
  ): Promise<ParallelAgentResult> {
    return this.runParallelInternal(inputs, options ?? {});
  }

  private async runParallelInternal(
    inputs: { agent_id: string; input: string }[],
    options: { timeout_ms?: number },
  ): Promise<ParallelAgentResult> {
    if (inputs.length === 0) {
      throw new Error("runParallel requires at least one input.");
    }

    // Validate agent IDs up-front so we fail fast on typos
    const available = Object.keys(this._score.agents);
    for (const { agent_id } of inputs) {
      if (!getAgent(this._score.agents, agent_id)) {
        throw new Error(
          `Parallel input references unknown agent "${agent_id}". Available: ${available.join(", ")}`,
        );
      }
    }

    const agentIds = inputs.map((i) => i.agent_id);
    this.runtime.events.emit({ type: "parallel:start", agents: agentIds });

    const started = Date.now();

    const settled = await Promise.all(
      inputs.map(({ agent_id, input }) =>
        this.runOneWithTimeout(agent_id, input, options.timeout_ms).then(
          (result) => ({ agent_id, result }),
          (error: unknown) => ({ agent_id, error }),
        ),
      ),
    );

    const duration_ms = Date.now() - started;

    const results = new Map<string, AgentResult>();
    const completed: string[] = [];
    const total_usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
    let total_cost_usd = 0;
    const mergedLines: string[] = [];

    for (const outcome of settled) {
      if ("result" in outcome) {
        results.set(outcome.agent_id, outcome.result);
        completed.push(outcome.agent_id);
        total_usage.input_tokens += outcome.result.usage.input_tokens;
        total_usage.output_tokens += outcome.result.usage.output_tokens;
        total_cost_usd += estimateCostUsd(outcome.result.usage);
        mergedLines.push(
          `[${outcome.agent_id}] ${outcome.result.output}`,
        );
      } else {
        const message =
          outcome.error instanceof Error
            ? outcome.error.message
            : String(outcome.error);
        // Record a synthetic error result so callers see the failure
        // without having to track rejections separately.
        results.set(outcome.agent_id, {
          session_id: "",
          output: `[error] ${message}`,
          messages: [],
          turns: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
        });
        mergedLines.push(`[${outcome.agent_id}] [error] ${message}`);
      }
    }

    this.runtime.events.emit({
      type: "parallel:complete",
      results: completed,
    });

    return {
      results,
      merged_output: mergedLines.join("\n\n"),
      total_usage,
      total_cost_usd,
      duration_ms,
    };
  }

  private async runOneWithTimeout(
    agent_id: string,
    input: string,
    timeout_ms: number | undefined,
  ): Promise<AgentResult> {
    const run = this.runtime.run(agent_id, input);
    if (!timeout_ms) return run;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Agent "${agent_id}" exceeded timeout of ${timeout_ms}ms`,
            ),
          ),
        timeout_ms,
      );
    });
    try {
      return await Promise.race([run, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Collapse a parallel aggregate into a single {@link AgentResult} so the
   * existing `run()` signature stays intact when parallel entry is used.
   */
  private mergeToAgentResult(aggregate: ParallelAgentResult): AgentResult {
    const turns = [...aggregate.results.values()].reduce(
      (sum, r) => sum + r.turns,
      0,
    );
    return {
      session_id: "",
      output: aggregate.merged_output,
      messages: [],
      turns,
      usage: aggregate.total_usage,
    };
  }

  private buildRoutingScore(
    score: ScoreConfig,
    entryId: string,
  ): ScoreConfig {
    const entryAgent = getAgent(score.agents, entryId);
    if (!entryAgent) {
      throw new Error(`Entry agent "${entryId}" not found.`);
    }
    if (!entryAgent.delegates || entryAgent.delegates.length === 0) {
      throw new Error(`Entry agent "${entryId}" has no delegates.`);
    }
    const delegates = entryAgent.delegates;

    // Build the delegate tool
    const delegateTool = this.createDelegateTool(score, delegates, entryId);

    // Build a voice that carries the delegate tool
    const routerVoice: Voice = {
      name: "__tutti_router",
      required_permissions: [],
      tools: [delegateTool],
    };

    // Enhance the system prompt with delegate info
    const delegateDescriptions = delegates
      .map((id) => {
        const agent = getAgent(score.agents, id);
        return `  - "${id}": ${agent?.name ?? id}${agent?.description ? ` — ${agent.description}` : ""}`;
      })
      .join("\n");

    const enhancedPrompt = `${entryAgent.system_prompt}

You have the following specialist agents available via the delegate_to_agent tool:
${delegateDescriptions}

When the user's request matches a specialist's expertise, delegate to them with a clear task description. You can delegate to multiple specialists in sequence. After receiving a specialist's response, summarize the result for the user.`;

    // Return a new score with the modified entry agent
    const enhanced: ScoreConfig["agents"][string] = {
      ...entryAgent,
      system_prompt: enhancedPrompt,
      voices: [...entryAgent.voices, routerVoice],
    };
    return {
      ...score,
      agents: {
        ...score.agents,
        [entryId]: enhanced,
      },
    };
  }

  private createDelegateTool(
    score: ScoreConfig,
    delegateIds: string[],
    entryId: string,
  ): Tool<{ agent_id: string; task: string }> {
    const runtime = (): TuttiRuntime => this.runtime;
    const events = (): EventBus => this.runtime.events;
    const entryName = getAgent(score.agents, entryId)?.name ?? "orchestrator";

    const parameters = z.object({
      agent_id: z
        .enum(delegateIds as [string, ...string[]])
        .describe("Which specialist agent to delegate to"),
      task: z
        .string()
        .describe("The specific task description to pass to the specialist"),
    });

    return {
      name: "delegate_to_agent",
      description:
        "Delegate a task to a specialist agent. The specialist will complete the task and return the result.",
      parameters,
      execute: async (input) => {
        events().emit({
          type: "delegate:start",
          from: entryName,
          to: input.agent_id,
          task: input.task,
        });

        try {
          const result = await runtime().run(input.agent_id, input.task);

          events().emit({
            type: "delegate:end",
            from: entryName,
            to: input.agent_id,
            output: result.output,
          });

          return {
            content: result.output || "(specialist returned no output)",
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            content: `Delegation to "${input.agent_id}" failed: ${message}`,
            is_error: true,
          };
        }
      },
    };
  }
}
