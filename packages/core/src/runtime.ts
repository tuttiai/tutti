import type { AgentResult, ScoreConfig, Session } from "@tuttiai/types";
import { AgentRunner } from "./agent-runner.js";
import { EventBus } from "./event-bus.js";
import { InMemorySessionStore } from "./session-store.js";

export class TuttiRuntime {
  readonly events: EventBus;
  private sessions: InMemorySessionStore;
  private runner: AgentRunner;
  private score: ScoreConfig;

  constructor(score: ScoreConfig) {
    this.score = score;
    this.events = new EventBus();
    this.sessions = new InMemorySessionStore();
    this.runner = new AgentRunner(score.provider, this.events, this.sessions);
  }

  /**
   * Run an agent by name with the given user input.
   * Optionally pass a session_id to continue a conversation.
   */
  async run(
    agent_name: string,
    input: string,
    session_id?: string,
  ): Promise<AgentResult> {
    const agent = this.score.agents[agent_name];
    if (!agent) {
      const available = Object.keys(this.score.agents).join(", ");
      throw new Error(
        `Agent "${agent_name}" not found. Available agents: ${available}`,
      );
    }

    // Apply default model if agent doesn't specify one
    const resolvedAgent = agent.model
      ? agent
      : { ...agent, model: this.score.default_model ?? "claude-sonnet-4-20250514" };

    return this.runner.run(resolvedAgent, input, session_id);
  }

  /** Retrieve an existing session. */
  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }
}
