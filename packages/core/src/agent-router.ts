import { z } from "zod";
import type { AgentConfig, AgentResult, Tool, Voice } from "@tuttiai/types";
import { TuttiRuntime } from "./runtime.js";
import type { EventBus } from "./event-bus.js";
import type { ScoreConfig } from "@tuttiai/types";

/**
 * AgentRouter wraps TuttiRuntime and adds multi-agent delegation.
 *
 * The entry agent (orchestrator) gets a `delegate_to_agent` tool
 * automatically injected. When the orchestrator calls it, the router
 * runs the specialist agent and returns its output.
 */
export class AgentRouter {
  private runtime: TuttiRuntime;

  constructor(private _score: ScoreConfig) {
    // Build a modified score where the entry agent has the delegate tool
    const entryId = _score.entry ?? "orchestrator";
    const entryAgent = _score.agents[entryId];

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
      if (!_score.agents[delegateId]) {
        throw new Error(
          `Delegate "${delegateId}" not found in agents. Available: ${Object.keys(_score.agents).join(", ")}`,
        );
      }
    }

    // Create the runtime with the modified score
    const modifiedScore = this.buildRoutingScore(_score, entryId);
    this.runtime = new TuttiRuntime(modifiedScore);
  }

  /** EventBus from the underlying runtime — subscribe to all events. */
  get events(): EventBus {
    return this.runtime.events;
  }

  /**
   * Send input to the entry agent. The orchestrator will delegate
   * to specialists as needed and return the final result.
   */
  async run(input: string, session_id?: string): Promise<AgentResult> {
    const entryId = this._score.entry ?? "orchestrator";
    return this.runtime.run(entryId, input, session_id);
  }

  private buildRoutingScore(
    score: ScoreConfig,
    entryId: string,
  ): ScoreConfig {
    const entryAgent = score.agents[entryId];
    const delegates = entryAgent.delegates!;

    // Build the delegate tool
    const delegateTool = this.createDelegateTool(score, delegates);

    // Build a voice that carries the delegate tool
    const routerVoice: Voice = {
      name: "__tutti_router",
      required_permissions: [],
      tools: [delegateTool],
    };

    // Enhance the system prompt with delegate info
    const delegateDescriptions = delegates
      .map((id) => {
        const agent = score.agents[id];
        return `  - "${id}": ${agent.name}${agent.description ? ` — ${agent.description}` : ""}`;
      })
      .join("\n");

    const enhancedPrompt = `${entryAgent.system_prompt}

You have the following specialist agents available via the delegate_to_agent tool:
${delegateDescriptions}

When the user's request matches a specialist's expertise, delegate to them with a clear task description. You can delegate to multiple specialists in sequence. After receiving a specialist's response, summarize the result for the user.`;

    // Return a new score with the modified entry agent
    return {
      ...score,
      agents: {
        ...score.agents,
        [entryId]: {
          ...entryAgent,
          system_prompt: enhancedPrompt,
          voices: [...entryAgent.voices, routerVoice],
        },
      },
    };
  }

  private createDelegateTool(
    score: ScoreConfig,
    delegateIds: string[],
  ): Tool<{ agent_id: string; task: string }> {
    const runtime = () => this.runtime;
    const events = () => this.runtime.events;
    const entryName =
      score.agents[score.entry ?? "orchestrator"]?.name ?? "orchestrator";

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
