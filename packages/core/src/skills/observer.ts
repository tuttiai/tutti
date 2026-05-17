/**
 * `TrajectoryObserver` — the "watch what works" half of self-improving
 * skills.
 *
 * Wired into {@link AgentRunner} alongside the dialectic-user-model
 * consolidator. After every completed run, the observer persists the
 * tool-call sequence to a {@link SkillStore} so the synthesiser (in a
 * follow-up package) can mine recurring shapes for new skill
 * candidates.
 *
 * The observer is intentionally minimal:
 *   - It does not classify, cluster, or summarise.
 *   - It does not own a queue or batch — every call is one store write.
 *   - It never crashes the runtime: the entire body is wrapped in a
 *     `try`/`catch` and failures degrade to a `logger.warn`.
 *
 * Outcome classification is structural, not semantic:
 *   - `success` — no thrown error, ≥ 1 tool call, every call succeeded.
 *   - `failure` — a thrown error OR any tool call failed.
 *   - `unknown` — everything else (chat-only run, no calls, no error).
 *
 * The `input_hash` field on each {@link TrajectoryToolCall} is the
 * sha256 digest of a canonical (sorted-key) JSON serialisation of the
 * tool input. Callers are expected to compute these via
 * {@link hashToolInput} so every observer sees identical hashes for
 * identical inputs.
 *
 * @module
 */

import { createHash } from "node:crypto";

import type {
  SkillStore,
  Trajectory,
  TrajectoryOutcome,
  TrajectoryToolCall,
} from "@tuttiai/skills";

import type { EventBus } from "../event-bus.js";
import { logger } from "../logger.js";

/** Default for {@link TrajectoryObserverOptions.minDurationMs}. */
export const DEFAULT_MIN_DURATION_MS = 1000;
/** Default for {@link TrajectoryObserverOptions.maxToolCallsPerRun}. */
export const DEFAULT_MAX_TOOL_CALLS_PER_RUN = 50;
/** Default for {@link TrajectoryObserverOptions.proposeEveryN}. */
export const DEFAULT_PROPOSE_EVERY_N = 10;

/**
 * Minimal structural subset of `SkillProposer` — the surface the
 * observer needs to kick a background scan. Declared locally to avoid
 * a circular import with `./proposer.js` and to keep the observer
 * usable in tests without constructing a real proposer.
 */
export interface SkillProposerLike {
  scanAndPropose(agentName: string): Promise<void>;
}

/** Wiring options for {@link TrajectoryObserver}. */
export interface TrajectoryObserverOptions {
  /** Backing store — typically the runtime's `InMemorySkillStore`. */
  store: SkillStore;
  /**
   * Floor on run duration before the observer records anything.
   * Trivial sub-second runs (failed setup, validation rejection,
   * quick chat-only replies) flood the store with noise the
   * synthesiser cannot use. Default 1000 ms.
   */
  minDurationMs?: number;
  /**
   * Ceiling on `tool_calls.length` — runs above the cap are
   * **truncated** (the first N kept), not dropped, so a runaway run
   * still leaves a recoverable prefix. Default 50.
   */
  maxToolCallsPerRun?: number;
  /**
   * Optional bus for `skill:trajectory_recorded`. When omitted, the
   * observer still records — emissions become no-ops.
   */
  events?: EventBus;
  /**
   * Optional proposer — when wired, the observer kicks a background
   * `scanAndPropose(agentName)` call every {@link proposeEveryN}
   * trajectories it records for that agent. Fire-and-forget; failures
   * inside the proposer are caught by the proposer itself.
   */
  proposer?: SkillProposerLike;
  /**
   * Cadence for proposer kicks, in trajectories per agent. Default 10.
   * Ignored when {@link proposer} is not set.
   */
  proposeEveryN?: number;
}

/**
 * Single-run input handed to {@link TrajectoryObserver.observe} by the
 * runtime. All fields except `error` and `user_id` / `final_message`
 * are required.
 */
export interface TrajectoryObservationInput {
  /** Trajectory id — caller-generated (`randomUUID()` is fine). */
  run_id: string;
  /** Agent that produced the run. */
  agent_name: string;
  /** End-user id when the run was started with `AgentRunOptions.user_id`. */
  user_id?: string;
  /** Run start (inclusive). */
  started_at: Date;
  /** Run end (inclusive). */
  ended_at: Date;
  /** Tool calls collected by the runner in invocation order. */
  tool_calls: TrajectoryToolCall[];
  /** Final assistant message text, when the run produced one. */
  final_message?: string;
  /**
   * Error that aborted the run, when applicable. Presence flips the
   * outcome to `"failure"` regardless of how many tool calls
   * succeeded before the error.
   */
  error?: Error;
}

/**
 * Records observed agent runs to a {@link SkillStore}. Construct once
 * per runtime; pass to {@link AgentRunner} via its constructor.
 *
 * Safe to call concurrently — every `observe` call is independent and
 * the store is expected to be concurrency-safe within a single Node
 * event loop.
 */
export class TrajectoryObserver {
  private readonly store: SkillStore;
  private readonly minDurationMs: number;
  private readonly maxToolCallsPerRun: number;
  private readonly events: EventBus | undefined;
  private readonly proposer: SkillProposerLike | undefined;
  private readonly proposeEveryN: number;
  /** Per-agent count of successfully recorded trajectories. */
  private readonly observedCounts = new Map<string, number>();

  constructor(opts: TrajectoryObserverOptions) {
    this.store = opts.store;
    this.minDurationMs = opts.minDurationMs ?? DEFAULT_MIN_DURATION_MS;
    this.maxToolCallsPerRun =
      opts.maxToolCallsPerRun ?? DEFAULT_MAX_TOOL_CALLS_PER_RUN;
    this.events = opts.events;
    this.proposer = opts.proposer;
    this.proposeEveryN = opts.proposeEveryN ?? DEFAULT_PROPOSE_EVERY_N;
  }

  /**
   * Persist `input` as a {@link Trajectory}. Never throws — store and
   * event-bus failures are caught and logged. Callers invoke this
   * fire-and-forget (`void observer.observe({...})`).
   *
   * Returns `Promise<void>` rather than `void` so tests can await
   * completion; production callers ignore the promise.
   */
  async observe(input: TrajectoryObservationInput): Promise<void> {
    try {
      const duration = input.ended_at.getTime() - input.started_at.getTime();
      if (duration < this.minDurationMs) {
        return;
      }

      const truncated =
        input.tool_calls.length > this.maxToolCallsPerRun
          ? input.tool_calls.slice(0, this.maxToolCallsPerRun)
          : input.tool_calls;

      const outcome = classifyOutcome(truncated, input.error);

      const trajectory: Trajectory = {
        id: input.run_id,
        agent_name: input.agent_name,
        started_at: input.started_at,
        ended_at: input.ended_at,
        tool_calls: truncated,
        outcome,
        ...(input.user_id !== undefined ? { user_id: input.user_id } : {}),
        ...(input.final_message !== undefined
          ? { final_message: input.final_message }
          : {}),
      };

      await this.store.recordTrajectory(trajectory);

      this.events?.emit({
        type: "skill:trajectory_recorded",
        agent_name: input.agent_name,
        trajectory_id: input.run_id,
        tool_count: truncated.length,
      });

      this.maybeKickProposer(input.agent_name);
    } catch (err) {
      logger.warn(
        {
          error: err instanceof Error ? err.message : String(err),
          agent: input.agent_name,
          run_id: input.run_id,
        },
        "TrajectoryObserver.observe failed — trajectory not recorded",
      );
    }
  }

  /**
   * Bump the per-agent counter and, when it crosses a multiple of
   * `proposeEveryN`, fire-and-forget a proposer scan. Caught errors
   * inside the proposer keep this from ever throwing.
   */
  private maybeKickProposer(agentName: string): void {
    if (!this.proposer) return;
    const next = (this.observedCounts.get(agentName) ?? 0) + 1;
    this.observedCounts.set(agentName, next);
    if (next % this.proposeEveryN !== 0) return;
    // Local copy: the field is readonly and the promise is detached.
    const proposer = this.proposer;
    void proposer.scanAndPropose(agentName).catch((err) => {
      logger.warn(
        {
          error: err instanceof Error ? err.message : String(err),
          agent: agentName,
        },
        "SkillProposer.scanAndPropose rejected — kick swallowed",
      );
    });
  }
}

/**
 * sha256 hex digest of a canonical (sorted-key) JSON serialisation of
 * `input`. Exported so the runtime — the one that actually sees raw
 * tool inputs — can compute hashes without re-implementing the
 * canonicalisation. Two inputs with the same key/value content but
 * different insertion order produce the same hash.
 */
export function hashToolInput(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

/**
 * Decide the outcome label. Order matters: thrown errors win over
 * any tool-call success, and a no-tool-call run with no error is
 * `"unknown"` rather than `"success"` because the synthesiser cannot
 * learn anything from a chat-only run.
 */
function classifyOutcome(
  toolCalls: TrajectoryToolCall[],
  error: Error | undefined,
): TrajectoryOutcome {
  if (error) return "failure";
  if (toolCalls.some((c) => !c.succeeded)) return "failure";
  if (toolCalls.length === 0) return "unknown";
  return "success";
}

/**
 * Serialise `value` to JSON with object keys sorted lexicographically
 * at every depth. Arrays preserve their order — semantics matters
 * there. Primitives and null pass through unchanged.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sortKeys(v));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}
