import type { AgentResult, ScoreConfig, Session, SessionStore } from "@tuttiai/types";
import { AgentRunner } from "./agent-runner.js";
import { EventBus } from "./event-bus.js";
import { InMemorySessionStore } from "./session-store.js";
import { PostgresSessionStore } from "./memory/postgres.js";
import { PermissionGuard } from "./permission-guard.js";

export class TuttiRuntime {
  readonly events: EventBus;
  private _sessions: SessionStore;
  private _runner: AgentRunner;
  private _score: ScoreConfig;

  constructor(score: ScoreConfig) {
    this._score = score;
    this.events = new EventBus();
    this._sessions = TuttiRuntime.createStore(score);
    this._runner = new AgentRunner(score.provider, this.events, this._sessions);
  }

  /**
   * Create a runtime with async initialization (required for Postgres).
   * Prefer this over `new TuttiRuntime()` when using a database-backed store.
   */
  static async create(score: ScoreConfig): Promise<TuttiRuntime> {
    const runtime = new TuttiRuntime(score);
    if (runtime._sessions instanceof PostgresSessionStore) {
      await runtime._sessions.initialize();
    }
    return runtime;
  }

  private static createStore(score: ScoreConfig): SessionStore {
    const memory = score.memory;
    if (!memory || memory.provider === "in-memory") {
      return new InMemorySessionStore();
    }
    if (memory.provider === "postgres") {
      const url = memory.url ?? process.env.DATABASE_URL;
      if (!url) {
        throw new Error(
          "PostgreSQL session store requires a connection URL.\n" +
          "Set memory.url in your score, or DATABASE_URL in your .env file.",
        );
      }
      return new PostgresSessionStore(url);
    }
    throw new Error(
      `Unsupported memory provider: "${memory.provider}".\n` +
      `Supported: "in-memory", "postgres"`,
    );
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
        `Agent "${agent_name}" not found in your score.\n` +
        `Available agents: ${available}\n` +
        `Check your tutti.score.ts — the agent ID must match the key in the agents object.`,
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
