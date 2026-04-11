import type { AgentResult, ScoreConfig, Session } from "@tuttiai/types";
import { AgentRunner } from "./agent-runner.js";
import { EventBus } from "./event-bus.js";
import { InMemorySessionStore } from "./session-store.js";
import { PermissionGuard } from "./permission-guard.js";

export class TuttiRuntime {
  readonly events: EventBus;
  private _sessions: InMemorySessionStore;
  private _runner: AgentRunner;
  private _score: ScoreConfig;

  constructor(score: ScoreConfig) {
    this._score = score;
    this.events = new EventBus();
    this._sessions = new InMemorySessionStore();
    this._runner = new AgentRunner(score.provider, this.events, this._sessions);
  }

  /** The score configuration this runtime was created with. */
  get score(): ScoreConfig {
    return this._score;
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
    const agent = this._score.agents[agent_name];
    if (!agent) {
      const available = Object.keys(this._score.agents).join(", ");
      throw new Error(
        `Agent "${agent_name}" not found. Available agents: ${available}`,
      );
    }

    // Enforce voice permissions
    const granted = agent.permissions ?? [];
    for (const voice of agent.voices) {
      PermissionGuard.check(voice, granted);
      PermissionGuard.warn(voice);
    }

    // Apply default model if agent doesn't specify one
    const resolvedAgent = agent.model
      ? agent
      : { ...agent, model: this._score.default_model ?? "claude-sonnet-4-20250514" };

    return this._runner.run(resolvedAgent, input, session_id);
  }

  /** Retrieve an existing session. */
  getSession(id: string): Session | undefined {
    return this._sessions.get(id);
  }
}
