import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";

import { EventBus } from "@tuttiai/core";

import { InMemorySkillStore } from "../src/in-memory-store.js";
import type {
  Skill,
  SkillCandidate,
  Trajectory,
} from "../src/types.js";

const makeTrajectory = (overrides: Partial<Trajectory> = {}): Trajectory => ({
  id: "01HQ-traj-1",
  agent_name: "assistant",
  started_at: new Date("2026-05-17T10:00:00Z"),
  ended_at: new Date("2026-05-17T10:01:00Z"),
  tool_calls: [
    { tool: "read_file", input_hash: "h1", succeeded: true, duration_ms: 12 },
  ],
  outcome: "success",
  ...overrides,
});

const makeCandidate = (overrides: Partial<SkillCandidate> = {}): SkillCandidate => ({
  id: "01HQ-cand-1",
  name_suggestion: "summarise_repo",
  description: "Walk the repo and produce a one-paragraph summary.",
  signature: { input: z.object({ path: z.string() }) },
  constituent_tools: ["read_file", "list_directory"],
  evidence_trajectory_ids: ["01HQ-traj-1", "01HQ-traj-2"],
  proposed_at: new Date("2026-05-17T11:00:00Z"),
  ...overrides,
});

describe("InMemorySkillStore", () => {
  let store: InMemorySkillStore;

  beforeEach(() => {
    store = new InMemorySkillStore();
  });

  describe("recordTrajectory + listTrajectories", () => {
    it("returns nothing for an unseen agent", async () => {
      expect(await store.listTrajectories("ghost")).toEqual([]);
    });

    it("round-trips a trajectory", async () => {
      const t = makeTrajectory();
      await store.recordTrajectory(t);
      expect(await store.listTrajectories("assistant")).toEqual([t]);
    });

    it("filters by agent_name", async () => {
      await store.recordTrajectory(makeTrajectory({ id: "a", agent_name: "alpha" }));
      await store.recordTrajectory(makeTrajectory({ id: "b", agent_name: "beta" }));
      const result = await store.listTrajectories("alpha");
      expect(result.map((t) => t.id)).toEqual(["a"]);
    });

    it("orders newest first by ended_at", async () => {
      await store.recordTrajectory(
        makeTrajectory({ id: "old", ended_at: new Date("2026-05-01T00:00:00Z") }),
      );
      await store.recordTrajectory(
        makeTrajectory({ id: "new", ended_at: new Date("2026-05-15T00:00:00Z") }),
      );
      const result = await store.listTrajectories("assistant");
      expect(result.map((t) => t.id)).toEqual(["new", "old"]);
    });

    it("applies the `since` filter inclusively", async () => {
      const cutoff = new Date("2026-05-10T00:00:00Z");
      await store.recordTrajectory(
        makeTrajectory({ id: "before", ended_at: new Date("2026-05-09T23:59:59Z") }),
      );
      await store.recordTrajectory(
        makeTrajectory({ id: "at", ended_at: cutoff }),
      );
      await store.recordTrajectory(
        makeTrajectory({ id: "after", ended_at: new Date("2026-05-11T00:00:00Z") }),
      );
      const result = await store.listTrajectories("assistant", cutoff);
      expect(result.map((t) => t.id).sort()).toEqual(["after", "at"]);
    });

    it("overwrites on duplicate id (primary-key semantics)", async () => {
      await store.recordTrajectory(makeTrajectory({ outcome: "failure" }));
      await store.recordTrajectory(makeTrajectory({ outcome: "success" }));
      const [only] = await store.listTrajectories("assistant");
      expect(only?.outcome).toBe("success");
    });
  });

  describe("proposeCandidate + listCandidates", () => {
    it("returns nothing when no candidates exist", async () => {
      expect(await store.listCandidates()).toEqual([]);
    });

    it("round-trips a candidate", async () => {
      const c = makeCandidate();
      await store.proposeCandidate(c);
      expect(await store.listCandidates()).toEqual([c]);
    });

    it("orders newest first by proposed_at", async () => {
      await store.proposeCandidate(
        makeCandidate({ id: "old", proposed_at: new Date("2026-05-01T00:00:00Z") }),
      );
      await store.proposeCandidate(
        makeCandidate({ id: "new", proposed_at: new Date("2026-05-15T00:00:00Z") }),
      );
      const result = await store.listCandidates();
      expect(result.map((c) => c.id)).toEqual(["new", "old"]);
    });

    it("emits skill:candidate_proposed when an EventBus is wired in", async () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.on("skill:candidate_proposed", handler);
      const eventfulStore = new InMemorySkillStore({ events: bus });

      await eventfulStore.proposeCandidate(makeCandidate());

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        type: "skill:candidate_proposed",
        candidate_id: "01HQ-cand-1",
        name_suggestion: "summarise_repo",
        evidence_count: 2,
      });
    });
  });

  describe("approveCandidate", () => {
    it("moves the candidate into skills and removes it from candidates", async () => {
      await store.proposeCandidate(makeCandidate());
      const skill = await store.approveCandidate("01HQ-cand-1", { reviewed_by: "alice" });

      expect(skill.status).toBe("approved");
      expect(skill.reviewed_by).toBe("alice");
      expect(skill.reviewed_at).toBeInstanceOf(Date);
      expect(await store.listCandidates()).toEqual([]);
      const skills = await store.listSkills();
      expect(skills.map((s) => s.id)).toEqual([skill.id]);
    });

    it("preserves the candidate id on transition", async () => {
      await store.proposeCandidate(makeCandidate({ id: "stable-id" }));
      const skill = await store.approveCandidate("stable-id");
      expect(skill.id).toBe("stable-id");
    });

    it("stores an operator-edited system_prompt when provided", async () => {
      await store.proposeCandidate(makeCandidate());
      const skill = await store.approveCandidate("01HQ-cand-1", {
        system_prompt: "You are a repo summariser. Be terse.",
      });
      expect(skill.system_prompt).toBe("You are a repo summariser. Be terse.");
    });

    it("omits reviewed_by and system_prompt when not provided", async () => {
      await store.proposeCandidate(makeCandidate());
      const skill = await store.approveCandidate("01HQ-cand-1");
      expect("reviewed_by" in skill).toBe(false);
      expect("system_prompt" in skill).toBe(false);
    });

    it("throws when the candidate id is unknown", async () => {
      await expect(store.approveCandidate("missing")).rejects.toThrow(
        /No pending candidate/,
      );
    });

    it("emits skill:approved with reviewed_by forwarded", async () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.on("skill:approved", handler);
      const eventfulStore = new InMemorySkillStore({ events: bus });

      await eventfulStore.proposeCandidate(makeCandidate());
      await eventfulStore.approveCandidate("01HQ-cand-1", { reviewed_by: "bob" });

      expect(handler).toHaveBeenCalledWith({
        type: "skill:approved",
        skill_id: "01HQ-cand-1",
        name: "summarise_repo",
        reviewed_by: "bob",
      });
    });
  });

  describe("rejectCandidate", () => {
    it("removes the candidate and keeps a rejected skill for audit", async () => {
      await store.proposeCandidate(makeCandidate());
      await store.rejectCandidate("01HQ-cand-1", {
        reviewed_by: "carol",
        reason: "duplicates an existing skill",
      });

      expect(await store.listCandidates()).toEqual([]);
      const skills = await store.listSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0]?.status).toBe("rejected");
      expect(skills[0]?.reviewed_by).toBe("carol");
    });

    it("throws when the candidate id is unknown", async () => {
      await expect(store.rejectCandidate("missing")).rejects.toThrow(
        /No pending candidate/,
      );
    });

    it("emits skill:rejected with reason forwarded", async () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.on("skill:rejected", handler);
      const eventfulStore = new InMemorySkillStore({ events: bus });

      await eventfulStore.proposeCandidate(makeCandidate());
      await eventfulStore.rejectCandidate("01HQ-cand-1", {
        reviewed_by: "dave",
        reason: "too narrow",
      });

      expect(handler).toHaveBeenCalledWith({
        type: "skill:rejected",
        candidate_id: "01HQ-cand-1",
        reviewed_by: "dave",
        reason: "too narrow",
      });
    });

    it("emits skill:rejected with no extras when none provided", async () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.on("skill:rejected", handler);
      const eventfulStore = new InMemorySkillStore({ events: bus });

      await eventfulStore.proposeCandidate(makeCandidate());
      await eventfulStore.rejectCandidate("01HQ-cand-1");

      expect(handler).toHaveBeenCalledWith({
        type: "skill:rejected",
        candidate_id: "01HQ-cand-1",
      });
    });
  });

  describe("listSkills", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-10T10:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const approveBoth = async (s: InMemorySkillStore): Promise<Skill[]> => {
      await s.proposeCandidate(
        makeCandidate({
          id: "old",
          proposed_at: new Date("2026-05-10T10:00:00Z"),
          evidence_trajectory_ids: ["t-alpha"],
        }),
      );
      const oldSkill = await s.approveCandidate("old");

      // Advance fake time so reviewed_at differs deterministically.
      vi.setSystemTime(new Date("2026-05-15T10:00:00Z"));

      await s.proposeCandidate(
        makeCandidate({
          id: "new",
          proposed_at: new Date("2026-05-15T10:00:00Z"),
          evidence_trajectory_ids: ["t-beta"],
        }),
      );
      const newSkill = await s.approveCandidate("new");
      return [oldSkill, newSkill];
    };

    it("orders newest first by reviewed_at", async () => {
      await approveBoth(store);
      const result = await store.listSkills();
      expect(result.map((s) => s.id)).toEqual(["new", "old"]);
    });

    it("filters by agentName via evidence trajectories", async () => {
      await store.recordTrajectory(makeTrajectory({ id: "t-alpha", agent_name: "alpha" }));
      await store.recordTrajectory(makeTrajectory({ id: "t-beta", agent_name: "beta" }));
      await approveBoth(store);

      const alphaSkills = await store.listSkills("alpha");
      expect(alphaSkills.map((s) => s.id)).toEqual(["old"]);
      const betaSkills = await store.listSkills("beta");
      expect(betaSkills.map((s) => s.id)).toEqual(["new"]);
    });

    it("returns nothing when an agent's evidence trajectories aren't in the store", async () => {
      await approveBoth(store);
      expect(await store.listSkills("ghost")).toEqual([]);
    });
  });

  it("operates without an EventBus (emissions become no-ops)", async () => {
    // No bus passed in — propose/approve/reject must not throw.
    const c = makeCandidate();
    await store.proposeCandidate(c);
    await store.approveCandidate(c.id);

    const c2 = makeCandidate({ id: "c2" });
    await store.proposeCandidate(c2);
    await store.rejectCandidate(c2.id);

    const skills = await store.listSkills();
    expect(skills.map((s) => s.status).sort()).toEqual(["approved", "rejected"]);
  });
});
