/**
 * Tests for `tutti-ai skills` — exercise the pure helpers
 * (`buildToolCatalogue`, `resolveConstituents`), the per-subcommand
 * `runX` entry points, and the interactive `runSkillsReview` loop via
 * an injected stub {@link ReviewPrompts}.
 *
 * The interactive command itself (raw stdin, enquirer-driven REPL)
 * remains excluded from coverage; tests target `applyReviewDecision`
 * and `runSkillsReview` with a stub prompts surface so every branch
 * of the review loop fires without going near `process.stdin`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import chalk from "chalk";
import { z } from "zod";
import { InMemorySkillStore } from "@tuttiai/skills";
import type { SkillCandidate, Trajectory } from "@tuttiai/skills";
import type { ScoreConfig, Tool, Voice } from "@tuttiai/types";

import {
  applyReviewDecision,
  buildToolCatalogue,
  resolveConstituents,
  runSkillsList,
  runSkillsProposed,
  runSkillsReject,
  runSkillsReview,
  type ReviewPrompts,
  type SkillsContext,
} from "../../src/commands/skills.js";

// Pin chalk so colour-escape assertions fire in vitest's non-TTY env.
chalk.level = 1;

/* eslint-disable no-control-regex */
function stripAnsi(s: string): string {
  return s.replace(/\[[0-9;]*m/g, "");
}
/* eslint-enable no-control-regex */

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

/** Build a fake voice with named tools. Each tool defaults to non-destructive. */
function makeVoice(
  name: string,
  tools: Array<Partial<Tool> & Pick<Tool, "name">>,
  required_permissions: Voice["required_permissions"] = [],
): Voice {
  return {
    name,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      parameters: t.parameters ?? z.object({}),
      execute:
        t.execute ?? (async () => ({ content: "", is_error: false })),
      ...(t.destructive !== undefined ? { destructive: t.destructive } : {}),
    })),
    required_permissions,
  };
}

/** Minimal viable score with a single agent and the given voices. */
function makeScore(voices: Voice[]): ScoreConfig {
  return {
    name: "test",
    provider: { chat: async () => ({ content: "" }) } as unknown as ScoreConfig["provider"],
    agents: {
      assistant: {
        name: "assistant",
        system_prompt: "you are a helpful test assistant",
        voices,
      },
    },
    skills: { enabled: true },
  };
}

function makeTrajectory(overrides: Partial<Trajectory> = {}): Trajectory {
  return {
    id: "traj-" + Math.random().toString(36).slice(2, 10),
    agent_name: "assistant",
    started_at: new Date("2026-05-17T10:00:00Z"),
    ended_at: new Date("2026-05-17T10:00:05Z"),
    tool_calls: [],
    outcome: "success",
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    id: "cand-" + Math.random().toString(36).slice(2, 10),
    name_suggestion: "Summarise inbox",
    description: "Summarise the inbox into bullet points.",
    signature: { input: z.object({ since: z.string() }) },
    constituent_tools: ["read_email", "search_inbox"],
    evidence_trajectory_ids: [],
    proposed_at: new Date("2026-05-17T10:00:00Z"),
    ...overrides,
  };
}

/** Build a {@link SkillsContext} backed by an in-memory store, capturing
 *  every line emitted via `out` so assertions can read them back. */
function makeCtx(voices: Voice[]): SkillsContext & { lines: string[] } {
  const store = new InMemorySkillStore();
  const score = makeScore(voices);
  const lines: string[] = [];
  return {
    store,
    score,
    out: (line: string) => lines.push(line),
    lines,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/*  buildToolCatalogue                                                 */
/* ------------------------------------------------------------------ */

describe("buildToolCatalogue", () => {
  it("indexes every tool across every agent's voices", () => {
    const voices = [
      makeVoice("email", [{ name: "read_email" }, { name: "send_email", destructive: true }], [
        "network",
      ]),
      makeVoice("inbox", [{ name: "search_inbox" }], ["network"]),
    ];
    const cat = buildToolCatalogue(makeScore(voices));
    expect([...cat.keys()].sort()).toEqual(["read_email", "search_inbox", "send_email"]);
    expect(cat.get("send_email")?.tool.destructive).toBe(true);
    expect(cat.get("send_email")?.voiceRequiredPermissions).toEqual(["network"]);
  });

  it("first voice wins when two voices declare the same tool name", () => {
    const voices = [
      makeVoice("a", [{ name: "shared" }]),
      makeVoice("b", [{ name: "shared", destructive: true }]),
    ];
    const cat = buildToolCatalogue(makeScore(voices));
    expect(cat.get("shared")?.voiceName).toBe("a");
    expect(cat.get("shared")?.tool.destructive).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  resolveConstituents                                                */
/* ------------------------------------------------------------------ */

describe("resolveConstituents", () => {
  it("computes destructive union and deduplicated permission union", () => {
    const voices = [
      makeVoice("email", [{ name: "send_email", destructive: true }], ["network", "filesystem"]),
      makeVoice("inbox", [{ name: "search_inbox" }], ["network"]),
    ];
    const cat = buildToolCatalogue(makeScore(voices));
    const candidate = makeCandidate({ constituent_tools: ["send_email", "search_inbox"] });
    const res = resolveConstituents(candidate, cat);
    expect(res.is_destructive).toBe(true);
    expect(res.required_permissions).toEqual(["filesystem", "network"]);
    expect(res.missing).toEqual([]);
  });

  it("flags missing constituents so callers can block approval", () => {
    const voices = [makeVoice("email", [{ name: "read_email" }])];
    const cat = buildToolCatalogue(makeScore(voices));
    const candidate = makeCandidate({
      constituent_tools: ["read_email", "removed_tool"],
    });
    const res = resolveConstituents(candidate, cat);
    expect(res.missing).toEqual(["removed_tool"]);
    // Resolvable subset still informs the union — caller uses `missing` to gate.
    expect(res.is_destructive).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  runSkillsList                                                      */
/* ------------------------------------------------------------------ */

describe("runSkillsList", () => {
  it("prints the empty-state message when no skills are approved", async () => {
    const ctx = makeCtx([makeVoice("v", [{ name: "t" }])]);
    await runSkillsList(ctx);
    expect(stripAnsi(ctx.lines.join("\n"))).toContain("No approved skills yet.");
  });

  it("renders one row per approved skill", async () => {
    const ctx = makeCtx([makeVoice("v", [{ name: "t" }])]);
    const candidate = makeCandidate();
    await ctx.store.proposeCandidate(candidate);
    await ctx.store.approveCandidate(candidate.id, { is_destructive: true });
    await runSkillsList(ctx);
    const out = stripAnsi(ctx.lines.join("\n"));
    expect(out).toContain("Summarise inbox");
    expect(out).toContain("yes"); // destructive column
  });
});

/* ------------------------------------------------------------------ */
/*  runSkillsProposed                                                  */
/* ------------------------------------------------------------------ */

describe("runSkillsProposed", () => {
  it("prints the empty-state message when no candidates are pending", async () => {
    const ctx = makeCtx([makeVoice("v", [{ name: "t" }])]);
    await runSkillsProposed(ctx);
    expect(stripAnsi(ctx.lines.join("\n"))).toContain("No pending skill candidates.");
  });

  it("renders both candidates when two are pending", async () => {
    const ctx = makeCtx([makeVoice("v", [{ name: "t" }])]);
    const t = makeTrajectory();
    await ctx.store.recordTrajectory(t);
    await ctx.store.proposeCandidate(
      makeCandidate({ name_suggestion: "Triage email", evidence_trajectory_ids: [t.id] }),
    );
    await ctx.store.proposeCandidate(
      makeCandidate({ name_suggestion: "Draft reply", evidence_trajectory_ids: [t.id] }),
    );
    await runSkillsProposed(ctx);
    const out = stripAnsi(ctx.lines.join("\n"));
    expect(out).toContain("Triage email");
    expect(out).toContain("Draft reply");
    // Agent column resolved via the seeded trajectory.
    expect(out).toContain("assistant");
  });
});

/* ------------------------------------------------------------------ */
/*  runSkillsReject (non-interactive)                                  */
/* ------------------------------------------------------------------ */

describe("runSkillsReject", () => {
  it("rejects the candidate and prints a confirmation with the reason", async () => {
    const ctx = makeCtx([makeVoice("v", [{ name: "t" }])]);
    const cand = makeCandidate();
    await ctx.store.proposeCandidate(cand);
    await runSkillsReject(ctx, cand.id, { reason: "duplicates an existing skill" });
    expect(stripAnsi(ctx.lines.join("\n"))).toContain('Rejected Summarise inbox');
    expect(stripAnsi(ctx.lines.join("\n"))).toContain("duplicates an existing skill");
    const skills = await ctx.store.listSkills();
    expect(skills.map((s) => s.status)).toEqual(["rejected"]);
  });

  it("fails with a clear error when the candidate does not exist", async () => {
    const ctx = makeCtx([makeVoice("v", [{ name: "t" }])]);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
    await runSkillsReject(ctx, "missing-id", { reason: "x" });
    expect(stderr.mock.calls.flat().join("")).toContain('No pending candidate with id "missing-id"');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0; // reset so other tests aren't tainted
  });
});

/* ------------------------------------------------------------------ */
/*  applyReviewDecision                                                */
/* ------------------------------------------------------------------ */

describe("applyReviewDecision", () => {
  it("approve path: stores the skill with computed unions", async () => {
    const voices = [makeVoice("email", [{ name: "send_email", destructive: true }], ["network"])];
    const ctx = makeCtx(voices);
    const cand = makeCandidate({ constituent_tools: ["send_email"] });
    await ctx.store.proposeCandidate(cand);
    const cat = buildToolCatalogue(ctx.score);
    const resolution = resolveConstituents(cand, cat);
    const outcome = await applyReviewDecision(ctx, cand, resolution, { kind: "approve" });
    expect(outcome).toBe("applied");
    const [skill] = await ctx.store.listSkills();
    expect(skill?.is_destructive).toBe(true);
    expect(skill?.required_permissions).toEqual(["network"]);
    expect(skill?.system_prompt).toBeUndefined();
  });

  it("edit-then-approve path: stores the edited system prompt", async () => {
    const ctx = makeCtx([makeVoice("v", [{ name: "send_email" }])]);
    const cand = makeCandidate({ constituent_tools: ["send_email"] });
    await ctx.store.proposeCandidate(cand);
    const cat = buildToolCatalogue(ctx.score);
    const resolution = resolveConstituents(cand, cat);
    await applyReviewDecision(ctx, cand, resolution, {
      kind: "approve",
      system_prompt: "Edited prompt — be terse.",
    });
    const [skill] = await ctx.store.listSkills();
    expect(skill?.system_prompt).toBe("Edited prompt — be terse.");
  });

  it("reject path: stores a rejected record carrying the reason", async () => {
    const ctx = makeCtx([makeVoice("v", [{ name: "send_email" }])]);
    const cand = makeCandidate({ constituent_tools: ["send_email"] });
    await ctx.store.proposeCandidate(cand);
    const resolution = resolveConstituents(cand, buildToolCatalogue(ctx.score));
    await applyReviewDecision(ctx, cand, resolution, { kind: "reject", reason: " no thanks " });
    const [skill] = await ctx.store.listSkills();
    expect(skill?.status).toBe("rejected");
  });

  it("skip path: leaves the candidate untouched", async () => {
    const ctx = makeCtx([makeVoice("v", [{ name: "send_email" }])]);
    const cand = makeCandidate({ constituent_tools: ["send_email"] });
    await ctx.store.proposeCandidate(cand);
    const resolution = resolveConstituents(cand, buildToolCatalogue(ctx.score));
    const outcome = await applyReviewDecision(ctx, cand, resolution, { kind: "skip" });
    expect(outcome).toBe("skipped");
    const pending = await ctx.store.listCandidates();
    expect(pending).toHaveLength(1);
  });

  it("blocks approval with a clear error when a constituent tool is missing", async () => {
    // Score knows about `send_email` only; the candidate also requires
    // `removed_tool` — the voice was deleted between proposal and review.
    const ctx = makeCtx([makeVoice("v", [{ name: "send_email" }])]);
    const cand = makeCandidate({
      constituent_tools: ["send_email", "removed_tool"],
    });
    await ctx.store.proposeCandidate(cand);
    const resolution = resolveConstituents(cand, buildToolCatalogue(ctx.score));
    expect(resolution.missing).toEqual(["removed_tool"]);

    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await applyReviewDecision(ctx, cand, resolution, { kind: "approve" });
    expect(outcome).toBe("blocked");
    const msg = stderr.mock.calls.flat().join("");
    expect(msg).toContain("Cannot approve");
    expect(msg).toContain("removed_tool");
    expect(msg).toContain("reject"); // hint mentions the reject fallback
    // Candidate must still be pending — approval was blocked, not silently rejected.
    expect(await ctx.store.listCandidates()).toHaveLength(1);
    expect(await ctx.store.listSkills()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  runSkillsReview — interactive loop with stub prompts               */
/* ------------------------------------------------------------------ */

/**
 * Stub prompts that return a scripted sequence of answers. Each method
 * shifts from its own queue so tests can mix approve/edit/reject/skip
 * decisions in a single run.
 */
function scriptPrompts(script: {
  actions?: Array<"a" | "e" | "r" | "s">;
  editPrompts?: string[];
  rejectReasons?: string[];
}): ReviewPrompts {
  const actions = [...(script.actions ?? [])];
  const editPrompts = [...(script.editPrompts ?? [])];
  const rejectReasons = [...(script.rejectReasons ?? [])];
  return {
    async chooseAction() {
      const next = actions.shift();
      if (next === undefined) throw new Error("Stub: chooseAction called more than scripted");
      return next;
    },
    async editSystemPrompt(initial: string) {
      const next = editPrompts.shift();
      return next ?? initial;
    },
    async rejectReason() {
      const next = rejectReasons.shift();
      return next ?? "";
    },
  };
}

describe("runSkillsReview", () => {
  it("approves the candidate with default prompt when the operator chooses 'a'", async () => {
    const ctx = makeCtx([makeVoice("v", [{ name: "send_email" }])]);
    const cand = makeCandidate({ constituent_tools: ["send_email"] });
    await ctx.store.proposeCandidate(cand);
    await runSkillsReview(ctx, cand.id, scriptPrompts({ actions: ["a"] }));
    const [skill] = await ctx.store.listSkills();
    expect(skill?.status).toBe("approved");
    expect(skill?.system_prompt).toBeUndefined();
  });

  it("edit-then-approve: stores the edited prompt when the operator chooses 'e'", async () => {
    const ctx = makeCtx([makeVoice("v", [{ name: "send_email" }])]);
    const cand = makeCandidate({ constituent_tools: ["send_email"] });
    await ctx.store.proposeCandidate(cand);
    await runSkillsReview(
      ctx,
      cand.id,
      scriptPrompts({ actions: ["e"], editPrompts: ["Tighter prompt."] }),
    );
    const [skill] = await ctx.store.listSkills();
    expect(skill?.system_prompt).toBe("Tighter prompt.");
  });

  it("reject path: stores a rejection record with the operator's reason", async () => {
    const ctx = makeCtx([makeVoice("v", [{ name: "send_email" }])]);
    const cand = makeCandidate({ constituent_tools: ["send_email"] });
    await ctx.store.proposeCandidate(cand);
    await runSkillsReview(
      ctx,
      cand.id,
      scriptPrompts({ actions: ["r"], rejectReasons: ["overlaps existing skill"] }),
    );
    const [skill] = await ctx.store.listSkills();
    expect(skill?.status).toBe("rejected");
  });

  it("skip path: leaves the candidate pending", async () => {
    const ctx = makeCtx([makeVoice("v", [{ name: "send_email" }])]);
    const cand = makeCandidate({ constituent_tools: ["send_email"] });
    await ctx.store.proposeCandidate(cand);
    await runSkillsReview(ctx, cand.id, scriptPrompts({ actions: ["s"] }));
    expect(await ctx.store.listCandidates()).toHaveLength(1);
    expect(await ctx.store.listSkills()).toHaveLength(0);
  });

  it("walks every candidate when no id is given", async () => {
    const ctx = makeCtx([makeVoice("v", [{ name: "send_email" }])]);
    await ctx.store.proposeCandidate(
      makeCandidate({ name_suggestion: "first", constituent_tools: ["send_email"] }),
    );
    await ctx.store.proposeCandidate(
      makeCandidate({ name_suggestion: "second", constituent_tools: ["send_email"] }),
    );
    // Approve the first, skip the second.
    await runSkillsReview(ctx, undefined, scriptPrompts({ actions: ["a", "s"] }));
    const approved = (await ctx.store.listSkills()).filter((s) => s.status === "approved");
    expect(approved).toHaveLength(1);
    expect(await ctx.store.listCandidates()).toHaveLength(1);
  });

  it("blocks approval mid-walk when a constituent tool is missing, surfaces the error, and continues", async () => {
    const ctx = makeCtx([makeVoice("v", [{ name: "send_email" }])]);
    const bad = makeCandidate({
      name_suggestion: "bad-cand",
      constituent_tools: ["send_email", "vanished_tool"],
    });
    await ctx.store.proposeCandidate(bad);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    await runSkillsReview(ctx, bad.id, scriptPrompts({ actions: ["a"] }));
    expect(stderr.mock.calls.flat().join("")).toContain("vanished_tool");
    // Approval was blocked → candidate still pending, no skill stored.
    expect(await ctx.store.listCandidates()).toHaveLength(1);
    expect(await ctx.store.listSkills()).toHaveLength(0);
  });

  it("exits with a clear error when an id is given but no candidate matches", async () => {
    const ctx = makeCtx([makeVoice("v", [{ name: "send_email" }])]);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
    await runSkillsReview(ctx, "nope", scriptPrompts({}));
    expect(stderr.mock.calls.flat().join("")).toContain('No pending candidate with id "nope"');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("graceful exit when the operator hits Ctrl+C (prompt rejects)", async () => {
    const ctx = makeCtx([makeVoice("v", [{ name: "send_email" }])]);
    const cand = makeCandidate({ constituent_tools: ["send_email"] });
    await ctx.store.proposeCandidate(cand);
    const prompts: ReviewPrompts = {
      chooseAction: () => Promise.reject(new Error("ctrl+c")),
      editSystemPrompt: async (s) => s,
      rejectReason: async () => "",
    };
    // Should resolve (not reject) — the loop catches the rejection.
    await expect(runSkillsReview(ctx, cand.id, prompts)).resolves.toBeUndefined();
    expect(await ctx.store.listCandidates()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  Approval check on a Skill carries through to runSkillsList         */
/* ------------------------------------------------------------------ */

describe("end-to-end: approve via review, then list", () => {
  it("a candidate approved with destructive constituents shows DESTRUCTIVE=yes in the list", async () => {
    const voices = [makeVoice("email", [{ name: "send_email", destructive: true }], ["network"])];
    const ctx = makeCtx(voices);
    const t = makeTrajectory();
    await ctx.store.recordTrajectory(t);
    const cand = makeCandidate({
      constituent_tools: ["send_email"],
      evidence_trajectory_ids: [t.id],
    });
    await ctx.store.proposeCandidate(cand);
    await runSkillsReview(ctx, cand.id, scriptPrompts({ actions: ["a"] }));
    ctx.lines.length = 0; // discard review output, focus on list output
    await runSkillsList(ctx);
    const listOut = stripAnsi(ctx.lines.join("\n"));
    expect(listOut).toContain("Summarise inbox");
    expect(listOut).toContain("yes"); // destructive
    expect(listOut).toContain("assistant"); // agent resolved via trajectory
  });
});

