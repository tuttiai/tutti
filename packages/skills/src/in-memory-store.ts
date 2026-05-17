/**
 * Single-process reference implementation of {@link SkillStore}.
 *
 * Backed by three `Map`s — trajectories, pending candidates, and reviewed
 * skills. No cross-process or persistence guarantees. Suitable for tests
 * and single-node deployments where losing state on restart is acceptable.
 */

import type {
  ApproveCandidateOptions,
  RejectCandidateOptions,
  Skill,
  SkillCandidate,
  SkillStore,
  Trajectory,
} from "./types.js";

/**
 * Minimal structural subset of `@tuttiai/core`'s `EventBus` — the
 * surface this store actually needs. Declared locally to keep
 * `@tuttiai/skills` free of any compile-time edge into `@tuttiai/core`;
 * an imported `EventBus` from core still satisfies this shape and
 * passes through unchanged.
 */
export interface SkillEventBus {
  /** Emit one of the `skill:*` events declared on `TuttiEvent`. */
  emit(event: { type: string; [k: string]: unknown }): void;
}

/** Constructor options for {@link InMemorySkillStore}. */
export interface InMemorySkillStoreOptions {
  /**
   * Optional bus for `skill:*` events. When omitted, the store still
   * functions — emissions become no-ops. Typed as a structural
   * {@link SkillEventBus} so `@tuttiai/skills` does not need to import
   * `@tuttiai/core`; passing the runtime's real `EventBus` works
   * unchanged.
   */
  events?: SkillEventBus;
}

/** In-memory {@link SkillStore}. See module docstring for guarantees. */
export class InMemorySkillStore implements SkillStore {
  private readonly trajectories = new Map<string, Trajectory>();
  private readonly candidates = new Map<string, SkillCandidate>();
  private readonly skills = new Map<string, Skill>();
  private readonly events: SkillEventBus | undefined;

  constructor(options: InMemorySkillStoreOptions = {}) {
    this.events = options.events;
  }

  async recordTrajectory(trajectory: Trajectory): Promise<void> {
    this.trajectories.set(trajectory.id, trajectory);
  }

  async listTrajectories(agentName: string, since?: Date): Promise<Trajectory[]> {
    const cutoff = since?.getTime();
    const out: Trajectory[] = [];
    for (const t of this.trajectories.values()) {
      if (t.agent_name !== agentName) continue;
      if (cutoff !== undefined && t.ended_at.getTime() < cutoff) continue;
      out.push(t);
    }
    out.sort((a, b) => b.ended_at.getTime() - a.ended_at.getTime());
    return out;
  }

  async proposeCandidate(candidate: SkillCandidate): Promise<void> {
    this.candidates.set(candidate.id, candidate);
    this.events?.emit({
      type: "skill:candidate_proposed",
      candidate_id: candidate.id,
      name_suggestion: candidate.name_suggestion,
      evidence_count: candidate.evidence_trajectory_ids.length,
    });
  }

  async listCandidates(): Promise<SkillCandidate[]> {
    const out = Array.from(this.candidates.values());
    out.sort((a, b) => b.proposed_at.getTime() - a.proposed_at.getTime());
    return out;
  }

  async approveCandidate(id: string, opts: ApproveCandidateOptions = {}): Promise<Skill> {
    const candidate = this.candidates.get(id);
    if (!candidate) {
      throw new Error(`No pending candidate with id "${id}"`);
    }
    const skill: Skill = {
      ...candidate,
      status: "approved",
      reviewed_at: new Date(),
      is_destructive: opts.is_destructive ?? false,
      required_permissions: opts.required_permissions ?? [],
      ...(opts.reviewed_by !== undefined ? { reviewed_by: opts.reviewed_by } : {}),
      ...(opts.system_prompt !== undefined ? { system_prompt: opts.system_prompt } : {}),
    };
    this.skills.set(skill.id, skill);
    this.candidates.delete(id);
    this.events?.emit({
      type: "skill:approved",
      skill_id: skill.id,
      name: skill.name_suggestion,
      ...(opts.reviewed_by !== undefined ? { reviewed_by: opts.reviewed_by } : {}),
    });
    return skill;
  }

  async rejectCandidate(id: string, opts: RejectCandidateOptions = {}): Promise<void> {
    const candidate = this.candidates.get(id);
    if (!candidate) {
      throw new Error(`No pending candidate with id "${id}"`);
    }
    const skill: Skill = {
      ...candidate,
      status: "rejected",
      reviewed_at: new Date(),
      is_destructive: false,
      required_permissions: [],
      ...(opts.reviewed_by !== undefined ? { reviewed_by: opts.reviewed_by } : {}),
    };
    this.skills.set(skill.id, skill);
    this.candidates.delete(id);
    this.events?.emit({
      type: "skill:rejected",
      candidate_id: id,
      ...(opts.reviewed_by !== undefined ? { reviewed_by: opts.reviewed_by } : {}),
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
  }

  async listSkills(agentName?: string): Promise<Skill[]> {
    const all = Array.from(this.skills.values());
    const filtered = agentName === undefined ? all : all.filter((s) => this.skillCoversAgent(s, agentName));
    filtered.sort((a, b) => b.reviewed_at.getTime() - a.reviewed_at.getTime());
    return filtered;
  }

  /**
   * True when at least one of `skill.evidence_trajectory_ids` resolves to a
   * stored trajectory belonging to `agentName`. Best-effort — if evidence
   * trajectories have been evicted, the skill is treated as not matching.
   */
  private skillCoversAgent(skill: Skill, agentName: string): boolean {
    for (const trajectoryId of skill.evidence_trajectory_ids) {
      const trajectory = this.trajectories.get(trajectoryId);
      if (trajectory && trajectory.agent_name === agentName) return true;
    }
    return false;
  }
}
