/**
 * Public types for `@tuttiai/skills`.
 *
 * The package is built around three nouns:
 *
 * - {@link Trajectory} — the recorded tool-call sequence of one agent run.
 * - {@link SkillCandidate} — a synthesiser's proposal that a recurring
 *   trajectory shape should become a callable skill. Awaits operator review.
 * - {@link Skill} — an approved candidate, callable by the runtime.
 *
 * The {@link SkillStore} interface unifies persistence over all three; the
 * shipped reference implementation is `InMemorySkillStore`.
 */

import type { ZodTypeAny } from "zod";

/**
 * A single tool invocation inside a {@link Trajectory}. The store does not
 * retain raw inputs — only a stable hash — so trajectories can be archived
 * without re-redacting secret-bearing arguments.
 */
export interface TrajectoryToolCall {
  /** Tool name, e.g. `read_file`. Snake-case per repo convention. */
  tool: string;
  /**
   * sha256 hex digest of a stable JSON serialisation of the tool input.
   * Callers are responsible for stable key ordering — the store treats this
   * as an opaque identifier and never re-hashes.
   */
  input_hash: string;
  /** Whether the tool returned a non-error {@link import("@tuttiai/types").ToolResult}. */
  succeeded: boolean;
  /** Wall-clock duration of the tool call in milliseconds. */
  duration_ms: number;
}

/** Outcome label attached to a trajectory; informs synthesiser weighting. */
export type TrajectoryOutcome = "success" | "failure" | "unknown";

/**
 * One recorded agent run, suitable for offline analysis. Trajectories are
 * append-only — once recorded they are never mutated by the store.
 */
export interface Trajectory {
  /** ULID (caller-generated). The store does not assign IDs. */
  id: string;
  /** Agent that produced this run. */
  agent_name: string;
  /** Optional end-user identifier. Omit for anonymous/system runs. */
  user_id?: string;
  /** Run start (inclusive). */
  started_at: Date;
  /** Run end (inclusive). */
  ended_at: Date;
  /** Tool calls in invocation order. May be empty for chat-only runs. */
  tool_calls: TrajectoryToolCall[];
  /**
   * Last assistant message of the run, when applicable. Omit when the run
   * ended without an assistant turn (e.g. budget exceeded mid-tool).
   */
  final_message?: string;
  /** Operator-supplied outcome label. */
  outcome: TrajectoryOutcome;
}

/**
 * Input/output schema pair for a synthesised skill.
 *
 * Schemas are kept as Zod refs so the runtime can re-use them at call sites
 * without re-deriving from JSON Schema. Output is optional — many skills are
 * effectful and have no useful return value.
 *
 * Persisting a `SkillSignature` to disk requires converting both schemas to
 * a serialisable form (e.g. `zod-to-json-schema`); the in-memory store keeps
 * the Zod refs as-is.
 */
export interface SkillSignature {
  /** Schema validating the skill's input. */
  input: ZodTypeAny;
  /** Schema validating the skill's output. Omit for effectful skills. */
  output?: ZodTypeAny;
}

/**
 * Synthesiser-proposed skill, awaiting operator review. Constituent tools
 * and evidence trajectories are non-empty by construction; the store does
 * not validate cardinality (callers — typically the synthesiser — enforce
 * a minimum, conventionally five evidence trajectories).
 */
export interface SkillCandidate {
  /** ULID (caller-generated). */
  id: string;
  /** LLM-generated human-readable name. May change on operator edit at approve time. */
  name_suggestion: string;
  /** LLM-generated description, surfaced to the agent at call time. */
  description: string;
  /** Input/output schema. */
  signature: SkillSignature;
  /** Unique tool names observed across the evidence trajectories. */
  constituent_tools: string[];
  /**
   * Trajectory IDs the synthesiser used as evidence. Conventionally at
   * least five — fewer is allowed by the store but discouraged by the
   * synthesiser contract.
   */
  evidence_trajectory_ids: string[];
  /** Wall-clock time the synthesiser produced the proposal. */
  proposed_at: Date;
}

/**
 * An approved {@link SkillCandidate}. Inherits all candidate fields and
 * adds review metadata; the `id` is preserved across the transition so
 * downstream references stay valid.
 */
export interface Skill extends SkillCandidate {
  /** Review outcome. `"rejected"` skills are kept for audit; runtimes should ignore them. */
  status: "approved" | "rejected";
  /** Operator identifier. Absent when reviewed programmatically. */
  reviewed_by?: string;
  /** Wall-clock time of the review. */
  reviewed_at: Date;
  /**
   * Operator-edited system prompt that replaces the synthesiser-generated
   * description when the runtime composes the skill's tool definition.
   * Absent means the runtime falls back to {@link SkillCandidate.description}.
   */
  system_prompt?: string;
  /**
   * Union over the constituent tools' `destructive` flag. Computed at
   * approval time and stored on the skill so the runtime can mark the
   * synthesised skill tool destructive without re-resolving constituents
   * at every run. Defaults to `false` when not supplied at approval.
   */
  is_destructive: boolean;
  /**
   * Union of `required_permissions` across constituent tools. Computed at
   * approval time. The runtime enforces these against the calling agent's
   * granted permissions at run start. Strings rather than the `Permission`
   * union so this package stays free of a hard `@tuttiai/types` import;
   * the runtime narrows them where needed.
   */
  required_permissions: string[];
}

/** Options accepted by {@link SkillStore.approveCandidate}. */
export interface ApproveCandidateOptions {
  /** Operator identifier. Forwarded to the emitted `skill:approved` event. */
  reviewed_by?: string;
  /** Operator-edited prompt override; see {@link Skill.system_prompt}. */
  system_prompt?: string;
  /**
   * Pre-computed destructive union across constituent tools. The
   * approval step (typically `@tuttiai/studio`) resolves each
   * constituent against the runtime's tool registry and passes the
   * union here. Defaults to `false` when omitted.
   */
  is_destructive?: boolean;
  /**
   * Pre-computed permission union across constituent tools. The
   * approval step resolves each constituent and passes the deduplicated
   * union here. Defaults to `[]` when omitted.
   */
  required_permissions?: string[];
}

/** Options accepted by {@link SkillStore.rejectCandidate}. */
export interface RejectCandidateOptions {
  /** Operator identifier. Forwarded to the emitted `skill:rejected` event. */
  reviewed_by?: string;
  /** Free-text reason. Forwarded to the emitted `skill:rejected` event. */
  reason?: string;
}

/**
 * Persistence contract for trajectories, candidates, and approved skills.
 *
 * Implementations must be safe to call concurrently from a single Node
 * event loop; cross-process safety is the implementation's choice. The
 * in-memory reference implementation is single-process only.
 */
export interface SkillStore {
  /**
   * Append a trajectory. Trajectories with the same `id` overwrite — the
   * store treats `id` as a primary key, not a uniqueness assertion.
   */
  recordTrajectory(trajectory: Trajectory): Promise<void>;

  /**
   * List trajectories for an agent, newest first by `ended_at`. When
   * `since` is given, only trajectories that ended at-or-after `since` are
   * returned.
   */
  listTrajectories(agentName: string, since?: Date): Promise<Trajectory[]>;

  /** Record a synthesiser proposal. Emits `skill:candidate_proposed`. */
  proposeCandidate(candidate: SkillCandidate): Promise<void>;

  /**
   * List all candidates that have not yet been approved or rejected,
   * newest first by `proposed_at`.
   */
  listCandidates(): Promise<SkillCandidate[]>;

  /**
   * Approve a pending candidate and return the resulting {@link Skill}.
   * The candidate is removed from the candidate list — query via
   * {@link SkillStore.listSkills} thereafter. Emits `skill:approved`.
   *
   * @throws {Error} when no pending candidate has the given `id`.
   */
  approveCandidate(id: string, opts?: ApproveCandidateOptions): Promise<Skill>;

  /**
   * Reject a pending candidate. The candidate is removed from the
   * candidate list and stored with `status: "rejected"` for audit.
   * Emits `skill:rejected`.
   *
   * @throws {Error} when no pending candidate has the given `id`.
   */
  rejectCandidate(id: string, opts?: RejectCandidateOptions): Promise<void>;

  /**
   * List skills (approved and rejected), newest first by `reviewed_at`.
   * When `agentName` is given, only skills whose constituent trajectories
   * include that agent are returned.
   */
  listSkills(agentName?: string): Promise<Skill[]>;
}
