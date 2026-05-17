/**
 * `SkillProposer` — the "propose what recurs" half of the self-improving
 * skills pipeline.
 *
 * Pairs with {@link TrajectoryObserver}: the observer records every
 * completed run, the proposer mines the recorded trajectories for
 * recurring tool-call shapes and asks a cheap LLM to name and describe
 * each one. Successful proposals are persisted as
 * {@link SkillCandidate}s on the same `SkillStore` the observer writes
 * to, awaiting operator approval (the third half — review — lives in
 * `@tuttiai/studio`).
 *
 * Everything is best-effort: the proposer is fire-and-forget, never
 * throws into its caller, and prefers dropping a proposal over
 * fabricating one.
 *
 * @module
 */

import { randomUUID } from "node:crypto";

import type {
  SkillCandidate,
  SkillStore,
  Trajectory,
  TrajectoryToolCall,
} from "@tuttiai/skills";
import type { ChatResponse, ContentBlock, LLMProvider } from "@tuttiai/types";
import { z } from "zod";

import type { EventBus } from "../event-bus.js";
import { logger } from "../logger.js";

/** Default Haiku-tier model — small, fast, cheap. */
export const DEFAULT_PROPOSER_MODEL = "claude-haiku-4-5";
/** Default for {@link SkillProposerOptions.autoProposeThreshold}. */
export const DEFAULT_AUTO_PROPOSE_THRESHOLD = 5;
/** Default for {@link SkillProposerOptions.trajectoryWindowDays}. */
export const DEFAULT_TRAJECTORY_WINDOW_DAYS = 14;
/** Cap on trajectories sampled into the prompt — keeps token cost bounded. */
const MAX_TRAJECTORY_SAMPLES = 5;

/**
 * LLM proposal schema. Inputs and outputs are accepted as opaque
 * JSON-Schema objects so the model has room to describe shape without
 * committing the runtime to a specific JSON-Schema validator — actual
 * input/output validation happens later, after operator approval, when
 * the operator wires a Zod schema in `@tuttiai/studio`.
 */
export const SkillCandidateProposalSchema = z.object({
  name_suggestion: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*$/, "must be snake_case starting with a letter"),
  description: z.string().min(1),
  signature: z.object({
    input_schema: z.record(z.unknown()),
    output_schema: z.record(z.unknown()),
  }),
});

/** Validated LLM response shape. */
export type SkillCandidateProposal = z.infer<typeof SkillCandidateProposalSchema>;

/** Wiring options for {@link SkillProposer}. */
export interface SkillProposerOptions {
  /** Backing store — must be the same store the observer writes to. */
  store: SkillStore;
  /** Cheap, fast LLM provider. Same provider interface as the runtime's. */
  llm: LLMProvider;
  /** Model identifier. Defaults to {@link DEFAULT_PROPOSER_MODEL}. */
  model?: string;
  /**
   * Minimum cluster size (trajectories sharing one tool sequence)
   * before the proposer asks the LLM to name and describe it. Default
   * 5 — fewer than that and the cluster is likely incidental.
   */
  autoProposeThreshold?: number;
  /**
   * How far back to look for trajectories. Default 14 days — wide
   * enough to catch weekly patterns, narrow enough that long-stale
   * shapes do not keep proposing themselves forever.
   */
  trajectoryWindowDays?: number;
  /** Optional bus for `skill:proposed`. Omit in tests when not needed. */
  events?: EventBus;
}

/**
 * Stateless w.r.t. agents — every `scanAndPropose` call re-reads the
 * store. Safe to share across runtimes.
 */
export class SkillProposer {
  private readonly store: SkillStore;
  private readonly llm: LLMProvider;
  private readonly model: string;
  private readonly autoProposeThreshold: number;
  private readonly trajectoryWindowDays: number;
  private readonly events: EventBus | undefined;

  constructor(opts: SkillProposerOptions) {
    this.store = opts.store;
    this.llm = opts.llm;
    this.model = opts.model ?? DEFAULT_PROPOSER_MODEL;
    this.autoProposeThreshold =
      opts.autoProposeThreshold ?? DEFAULT_AUTO_PROPOSE_THRESHOLD;
    this.trajectoryWindowDays =
      opts.trajectoryWindowDays ?? DEFAULT_TRAJECTORY_WINDOW_DAYS;
    this.events = opts.events;
  }

  /**
   * Scan recent trajectories for `agentName`, cluster them by tool
   * sequence, and ask the LLM to propose a {@link SkillCandidate} for
   * every cluster of size ≥ {@link SkillProposerOptions.autoProposeThreshold}.
   *
   * Fire-and-forget: errors are logged and swallowed. The caller can
   * await the promise in tests, but production callers ignore it.
   */
  async scanAndPropose(agentName: string): Promise<void> {
    try {
      const allForAgent = await this.store.listTrajectories(agentName);
      const cutoff =
        Date.now() - this.trajectoryWindowDays * 24 * 60 * 60 * 1000;
      const windowed = allForAgent.filter(
        (t) => t.ended_at.getTime() >= cutoff,
      );
      const successful = windowed.filter((t) => t.outcome === "success");
      if (successful.length < this.autoProposeThreshold) return;

      const clusters = clusterByToolSequence(successful);
      const trajectoryIndex = new Map(allForAgent.map((t) => [t.id, t]));
      const existingSignatures =
        await this.collectExistingSignatures(trajectoryIndex);
      const knownTools = collectKnownTools(allForAgent);

      for (const [signature, members] of clusters) {
        if (members.length < this.autoProposeThreshold) continue;
        if (existingSignatures.has(signature)) continue;
        await this.proposeFromCluster(agentName, signature, members, knownTools);
      }
    } catch (err) {
      logger.warn(
        { error: errMsg(err), agent: agentName },
        "SkillProposer.scanAndPropose failed — no candidates produced",
      );
    }
  }

  /**
   * Ask the LLM for one proposal, validate it, and persist it. Returns
   * silently on every failure path so the caller can move on to the
   * next cluster.
   */
  private async proposeFromCluster(
    agentName: string,
    signature: string,
    cluster: Trajectory[],
    knownTools: Set<string>,
  ): Promise<void> {
    const samples = cluster.slice(0, MAX_TRAJECTORY_SAMPLES);
    const system = buildSystemPrompt();
    const userMessage = buildUserMessage(signature, samples);

    let response: ChatResponse;
    try {
      response = await this.llm.chat({
        model: this.model,
        system,
        messages: [{ role: "user", content: userMessage }],
      });
    } catch (err) {
      logger.warn(
        { error: errMsg(err), agent: agentName, signature },
        "SkillProposer LLM call failed — skipping cluster",
      );
      return;
    }

    const text = extractText(response.content).trim();
    const proposal = parseProposal(text);
    if (!proposal) {
      logger.warn(
        { agent: agentName, signature, sample: text.slice(0, 120) },
        "SkillProposer produced unparseable JSON — skipping cluster",
      );
      return;
    }

    if (knownTools.has(proposal.name_suggestion)) {
      logger.warn(
        { agent: agentName, name: proposal.name_suggestion },
        "SkillProposer name collides with an existing tool — skipping",
      );
      return;
    }

    const candidate: SkillCandidate = {
      id: randomUUID(),
      name_suggestion: proposal.name_suggestion,
      description: proposal.description,
      signature: {
        input: z.unknown(),
        output: z.unknown(),
      },
      constituent_tools: Array.from(new Set(signature.split("→"))),
      evidence_trajectory_ids: samples.map((t) => t.id),
      proposed_at: new Date(),
    };

    try {
      await this.store.proposeCandidate(candidate);
    } catch (err) {
      logger.warn(
        { error: errMsg(err), agent: agentName, name: candidate.name_suggestion },
        "SkillProposer failed to persist candidate — skipping",
      );
      return;
    }

    this.events?.emit({
      type: "skill:proposed",
      agent_name: agentName,
      candidate_id: candidate.id,
      name_suggestion: candidate.name_suggestion,
      evidence_count: candidate.evidence_trajectory_ids.length,
    });
  }

  /**
   * Build a set of every tool-sequence signature already represented by
   * a pending candidate or a reviewed skill. Used to skip duplicate
   * proposals. Best-effort: signatures whose evidence trajectories
   * have fallen out of the per-agent index are silently omitted — the
   * worst case is a duplicate proposal the operator can reject.
   */
  private async collectExistingSignatures(
    index: Map<string, Trajectory>,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    const [candidates, skills] = await Promise.all([
      this.store.listCandidates(),
      this.store.listSkills(),
    ]);
    for (const c of candidates) {
      const sig = resolveSignature(c.evidence_trajectory_ids, index);
      if (sig !== null) out.add(sig);
    }
    for (const s of skills) {
      const sig = resolveSignature(s.evidence_trajectory_ids, index);
      if (sig !== null) out.add(sig);
    }
    return out;
  }
}

function resolveSignature(
  evidenceIds: readonly string[],
  index: Map<string, Trajectory>,
): string | null {
  for (const id of evidenceIds) {
    const t = index.get(id);
    if (t) return toolSignature(t.tool_calls);
  }
  return null;
}

function clusterByToolSequence(
  trajectories: Trajectory[],
): Map<string, Trajectory[]> {
  const clusters = new Map<string, Trajectory[]>();
  for (const t of trajectories) {
    const sig = toolSignature(t.tool_calls);
    if (sig === "") continue; // chat-only runs cannot form a skill
    const bucket = clusters.get(sig);
    if (bucket) {
      bucket.push(t);
    } else {
      clusters.set(sig, [t]);
    }
  }
  return clusters;
}

function toolSignature(calls: readonly TrajectoryToolCall[]): string {
  return calls.map((c) => c.tool).join("→");
}

function collectKnownTools(trajectories: readonly Trajectory[]): Set<string> {
  const out = new Set<string>();
  for (const t of trajectories) {
    for (const c of t.tool_calls) out.add(c.tool);
  }
  return out;
}

function buildSystemPrompt(): string {
  return (
    "You name and describe a candidate skill that captures the common " +
    "intent of several successful agent runs. You will receive: (a) the " +
    "tool sequence those runs share, and (b) a sample of trajectories — " +
    "each a list of tool invocations.\n\n" +
    "Output a single JSON object — and nothing else, no prose, no code " +
    "fences — with these fields:\n" +
    "  name_suggestion: snake_case identifier, lowercase letters / digits / " +
    "underscores only, starting with a letter. The name MUST NOT match any " +
    "existing tool used by the agent.\n" +
    "  description: one sentence describing what the skill does.\n" +
    "  signature: an object with `input_schema` and `output_schema` — each a " +
    "JSON Schema object (use `{}` if unknown).\n\n" +
    "Be conservative: only propose when the trajectories share a clear, " +
    "single intent. If the runs look like coincidence, output an empty " +
    "object `{}` and the runtime will skip the proposal.\n\n" +
    "NEVER include sensitive data: no passwords, API keys, secrets, " +
    "personal identifiers, payment-card numbers, or government identifiers. " +
    "Describe the shape of the work, not its arguments."
  );
}

function buildUserMessage(
  signature: string,
  samples: readonly Trajectory[],
): string {
  const samplesBlock = samples
    .map((t, i) => {
      const calls = t.tool_calls
        .map(
          (c) =>
            "    - " +
            c.tool +
            " (" +
            String(c.duration_ms) +
            "ms, succeeded=" +
            String(c.succeeded) +
            ")",
        )
        .join("\n");
      return "  Sample " + String(i + 1) + ":\n" + calls;
    })
    .join("\n");

  return (
    "Shared tool sequence:\n  " +
    signature +
    "\n\nEvidence trajectories (" +
    String(samples.length) +
    "):\n" +
    samplesBlock
  );
}

/**
 * Parse the LLM response. Tolerates code-fenced JSON and prose around
 * the object — matches the consolidator's parsing tolerance so the two
 * Haiku-tier callers degrade the same way.
 */
function parseProposal(text: string): SkillCandidateProposal | null {
  if (text === "") return null;
  let body = text.trim();
  const fence = /^```(?:json)?\n?([\s\S]*?)\n?```$/;
  const match = fence.exec(body);
  if (match && match[1]) body = match[1].trim();

  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return null;
  const sliced = body.slice(first, last + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(sliced);
  } catch {
    return null;
  }
  const result = SkillCandidateProposalSchema.safeParse(parsed);
  if (!result.success) return null;
  return result.data;
}

function extractText(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
