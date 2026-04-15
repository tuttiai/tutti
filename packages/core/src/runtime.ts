import type { AgentResult, ScoreConfig, Session, SessionStore, TelemetryConfig } from "@tuttiai/types";
import {
  JsonFileExporter,
  OTLPExporter,
  configureExporter,
  type SpanExporter,
} from "@tuttiai/telemetry";
import { AgentRunner } from "./agent-runner.js";
import type {
  AgentRunOptions,
  UserMemoryStore,
} from "./memory/user/types.js";
import type { CheckpointStore } from "./checkpoint/index.js";
import { EventBus } from "./event-bus.js";
import { InMemorySessionStore } from "./session-store.js";
import { PostgresSessionStore } from "./memory/postgres.js";
import { InMemorySemanticStore } from "./memory/in-memory-semantic.js";
import type { SemanticMemoryStore } from "./memory/semantic.js";
import type { ToolCache } from "./cache/tool-cache.js";
import { InMemoryToolCache } from "./cache/in-memory-cache.js";
import { PermissionGuard } from "./permission-guard.js";
import { SecretsManager } from "./secrets.js";
import { logger } from "./logger.js";
import { AgentNotFoundError, ScoreValidationError } from "./errors.js";
import { initTelemetry } from "./telemetry-setup.js";

/**
 * Resolve the exporter pipeline from (in order of precedence):
 *   1. `TUTTI_OTLP_ENDPOINT` / `TUTTI_TRACE_FILE` environment variables
 *   2. `score.telemetry.otlp` / `score.telemetry.jsonFile`
 *
 * Both sources may produce up to one OTLP exporter and one JSON-file
 * exporter. When both are present we prefer OTLP (single exporter slot;
 * users wanting both can subscribe a second listener directly).
 *
 * `score.telemetry.disabled` short-circuits the whole resolution.
 */
function resolveExporter(score: TelemetryConfig | undefined): SpanExporter | undefined {
  if (score?.disabled) return undefined;

  // Env vars win — they're the operator's "override the score" lever.
  const envOtlpEndpoint = SecretsManager.optional("TUTTI_OTLP_ENDPOINT");
  const envTraceFile = SecretsManager.optional("TUTTI_TRACE_FILE");

  const otlpEndpoint = envOtlpEndpoint ?? score?.otlp?.endpoint;
  const jsonFilePath = envTraceFile ?? score?.jsonFile;

  if (otlpEndpoint) {
    return new OTLPExporter({
      endpoint: otlpEndpoint,
      // Headers can only come from the score — env-var-encoded headers
      // would be an injection footgun.
      ...(score?.otlp?.headers ? { headers: score.otlp.headers } : {}),
      onError: (err) => {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "OTLP export failed",
        );
      },
    });
  }
  if (jsonFilePath) {
    return new JsonFileExporter({
      path: jsonFilePath,
      onError: (err) => {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "JSON file export failed",
        );
      },
    });
  }
  return undefined;
}

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
  /** Teardown for any exporter installed during construction. */
  private _stopExporter: (() => Promise<void>) | undefined;

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

    // Install a TuttiSpan exporter from env vars or score config, so all
    // spans the runtime emits get forwarded to the configured sink.
    const exporter = resolveExporter(score.telemetry);
    if (exporter) {
      this._stopExporter = configureExporter(exporter);
      logger.info(
        { exporter: exporter.constructor.name },
        "Span exporter configured",
      );
    }

    logger.info({ score: score.name, agents: Object.keys(score.agents) }, "Runtime initialized");
  }

  /**
   * Detach and shut down any installed span exporter. Idempotent. Call
   * this from long-running processes (servers, schedulers) before exit
   * so buffered spans get flushed.
   */
  async shutdown(): Promise<void> {
    if (this._stopExporter) {
      const stop = this._stopExporter;
      this._stopExporter = undefined;
      await stop();
    }
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
   *
   * @param agent_name - Agent key from the score's `agents` map.
   * @param input - End-user message / prompt.
   * @param session_id - Optional session to continue. Same semantics as
   *   `options.session_id` (positional arg wins on conflict, kept for
   *   back-compat).
   * @param options - Additional run-level options, including `user_id`
   *   which triggers user-memory fetch + inject at run start.
   */
  async run(
    agent_name: string,
    input: string,
    session_id?: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    const agentMap = new Map(Object.entries(this._score.agents));
    const agent = agentMap.get(agent_name);
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

    return this._runner.run(resolvedAgent, input, session_id, options);
  }

  /**
   * Pre-register a user-memory store for an agent so callers can inject
   * a custom store (e.g. a wrapper that adds metrics) without going
   * through the per-agent `createUserMemoryStore` factory. Forwards to
   * the underlying {@link AgentRunner.setUserMemoryStore}.
   */
  setUserMemoryStore(agent_name: string, store: UserMemoryStore): void {
    this._runner.setUserMemoryStore(agent_name, store);
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
