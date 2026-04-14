import type { AgentResult, ScoreConfig, Session, SessionStore } from "@tuttiai/types";
import { AgentRunner } from "./agent-runner.js";
import type { CheckpointStore } from "./checkpoint/index.js";
import { EventBus } from "./event-bus.js";
import { InMemorySessionStore } from "./session-store.js";
import { PostgresSessionStore } from "./memory/postgres.js";
import { InMemorySemanticStore } from "./memory/in-memory-semantic.js";
import type { SemanticMemoryStore } from "./memory/semantic.js";
import type { ToolCache } from "./cache/tool-cache.js";
import { InMemoryToolCache } from "./cache/in-memory-cache.js";
import { PermissionGuard } from "./permission-guard.js";
import { logger } from "./logger.js";
import { AgentNotFoundError, ScoreValidationError } from "./errors.js";
import { initTelemetry } from "./telemetry-setup.js";

/** Optional runtime overrides that don't belong in the score. */
export interface TuttiRuntimeOptions {
  /**
   * Attach a durable checkpoint store so agents with `durable: true` can
   * save turn boundaries and resume after a crash.
   */
  checkpointStore?: CheckpointStore;
  /**
   * Reuse an existing session store across runtime instances. Used by the
   * CLI's `--watch` mode so hot-reloading the score doesn't drop the
   * conversation history that lives in an `InMemorySessionStore`.
   * Overrides the score's `memory` config when supplied.
   */
  sessionStore?: SessionStore;
}

export class TuttiRuntime {
  readonly events: EventBus;
  readonly semanticMemory: SemanticMemoryStore;
  readonly toolCache: ToolCache;
  private _sessions: SessionStore;
  private _runner: AgentRunner;
  private _score: ScoreConfig;

  constructor(score: ScoreConfig, options: TuttiRuntimeOptions = {}) {
    this._score = score;
    this.events = new EventBus();
    this._sessions = options.sessionStore ?? TuttiRuntime.createStore(score);
    this.semanticMemory = new InMemorySemanticStore();
    this.toolCache = new InMemoryToolCache();
    this._runner = new AgentRunner(
      score.provider,
      this.events,
      this._sessions,
      this.semanticMemory,
      score.hooks,
      this.toolCache,
      options.checkpointStore,
    );

    if (score.telemetry) {
      initTelemetry(score.telemetry);
    }

    logger.info({ score: score.name, agents: Object.keys(score.agents) }, "Runtime initialized");
  }

  /**
   * Create a runtime with async initialization (required for Postgres).
   * Prefer this over `new TuttiRuntime()` when using a database-backed store.
   */
  static async create(
    score: ScoreConfig,
    options: TuttiRuntimeOptions = {},
  ): Promise<TuttiRuntime> {
    const runtime = new TuttiRuntime(score, options);
    if (runtime._sessions instanceof PostgresSessionStore) {
      await runtime._sessions.initialize();
    }
    return runtime;
  }

  /** Underlying session store — exposed so CLI flows like `resume` can seed
   *  a session by the id stored in a checkpoint before calling `run()`. */
  get sessions(): SessionStore {
    return this._sessions;
  }

  private static createStore(score: ScoreConfig): SessionStore {
    const memory = score.memory;
    if (!memory || memory.provider === "in-memory") {
      return new InMemorySessionStore();
    }
    if (memory.provider === "postgres") {
      const url = memory.url ?? process.env.DATABASE_URL;
      if (!url) {
        throw new ScoreValidationError(
          "PostgreSQL session store requires a connection URL.\n" +
          "Set memory.url in your score, or DATABASE_URL in your .env file.",
          { field: "memory.url" },
        );
      }
      return new PostgresSessionStore(url);
    }
    throw new ScoreValidationError(
      `Unsupported memory provider: "${memory.provider}".\n` +
      `Supported: "in-memory", "postgres"`,
      { field: "memory.provider", value: memory.provider },
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
    // eslint-disable-next-line security/detect-object-injection -- agent_name validated against score.agents below
    const agent = this._score.agents[agent_name];
    if (!agent) {
      throw new AgentNotFoundError(agent_name, Object.keys(this._score.agents));
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

  /**
   * Provide an answer to a pending human-in-the-loop request.
   * Call this when a `hitl:requested` event fires to resume the agent.
   */
  answer(sessionId: string, answer: string): void {
    this._runner.answer(sessionId, answer);
  }

  /** Retrieve an existing session. */
  getSession(id: string): Session | undefined {
    return this._sessions.get(id);
  }
}
