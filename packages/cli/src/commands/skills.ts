/**
 * `tutti-ai skills` — list, review, approve, and reject synthesised
 * skill candidates produced by the trajectory observer.
 *
 * Four user-facing subcommands:
 *
 *   `tutti-ai skills list`             — approved skills, newest first.
 *   `tutti-ai skills proposed`         — pending candidates.
 *   `tutti-ai skills review [id]`      — interactive walk-through; with
 *                                        an id, reviews just that one.
 *   `tutti-ai skills reject <id>`      — non-interactive reject.
 *
 * Resolution of `is_destructive` / `required_permissions` is performed
 * **here**, not in the store. The CLI loads the score, walks each
 * agent's voices, and produces a single tool-name catalogue. Approval
 * is blocked when a constituent tool no longer resolves — typically
 * because the voice was removed from the score after the candidate
 * was proposed. This matches the design contract on
 * {@link import("@tuttiai/skills").ApproveCandidateOptions} which says
 * the approval step (CLI or studio) computes the unions and passes them
 * via `opts`.
 *
 * Persistence note: today the runtime defaults to an
 * `InMemorySkillStore`. Each CLI invocation is a fresh process, so
 * candidates proposed by a previous `serve`/`run` invocation are not
 * visible here unless a persistent store is attached to the score.
 * The `list`/`proposed` commands print a one-line banner so operators
 * are not confused by empty output.
 *
 * This file is excluded from coverage in `vitest.config.ts` because of
 * the raw-stdin/enquirer interactive loop; the pure rendering lives in
 * `./skills-render.js` and is fully covered. The non-rendering helpers
 * (`buildToolCatalogue`, `resolveConstituents`, `applyReviewDecision`)
 * are also re-exported so unit tests exercise them directly.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import Enquirer from "enquirer";
import { ScoreLoader } from "@tuttiai/core";
import { InMemorySkillStore } from "@tuttiai/skills";
import type { SkillCandidate, SkillStore, Trajectory } from "@tuttiai/skills";
import type { ScoreConfig, Tool, Voice } from "@tuttiai/types";
import { logger } from "../logger.js";
import {
  renderApprovedSkill,
  renderCandidateDetail,
  renderCandidatesList,
  renderRejectedCandidate,
  renderReviewHeading,
  renderSkillsList,
  type ConstituentResolution,
  type EvidenceSample,
} from "./skills-render.js";

const { prompt } = Enquirer;

/* ------------------------------------------------------------------ */
/*  Pure helpers (tested directly)                                     */
/* ------------------------------------------------------------------ */

/**
 * Catalogue of every tool the loaded score exposes — keyed by tool
 * name, valued with the owning voice's name plus the tool itself.
 *
 * The map is a flat union across all agents' voices. A tool name that
 * appears under two agents collapses to one entry (first wins); two
 * voices declaring the same tool name is a score-author bug we don't
 * try to surface here — the runtime would have already rejected it.
 */
export interface ToolCatalogueEntry {
  voiceName: string;
  voiceRequiredPermissions: readonly string[];
  tool: Tool;
}

/**
 * Build a tool-name → {@link ToolCatalogueEntry} catalogue from a
 * loaded score. Iterates each agent's voices in declaration order so
 * the first-wins tie-break is stable. Returns an empty map for a
 * score with no agents (defensive — `defineScore` rejects this).
 */
export function buildToolCatalogue(
  score: ScoreConfig,
): Map<string, ToolCatalogueEntry> {
  const out = new Map<string, ToolCatalogueEntry>();
  for (const agent of Object.values(score.agents)) {
    for (const voice of agent.voices as readonly Voice[]) {
      for (const tool of voice.tools) {
        if (out.has(tool.name)) continue;
        out.set(tool.name, {
          voiceName: voice.name,
          voiceRequiredPermissions: voice.required_permissions,
          tool,
        });
      }
    }
  }
  return out;
}

/**
 * Resolve a candidate's `constituent_tools` against the catalogue.
 * Returns a precomputed `is_destructive` (any constituent destructive),
 * a deduplicated `required_permissions` union across the owning
 * voices, and the list of constituent names that no longer resolve.
 * When `missing` is non-empty, approval must be blocked — the union
 * fields still reflect the resolvable subset, but they are not
 * authoritative.
 */
export function resolveConstituents(
  candidate: SkillCandidate,
  catalogue: ReadonlyMap<string, ToolCatalogueEntry>,
): ConstituentResolution {
  const missing: string[] = [];
  const perms = new Set<string>();
  let destructive = false;

  for (const toolName of candidate.constituent_tools) {
    const entry = catalogue.get(toolName);
    if (!entry) {
      missing.push(toolName);
      continue;
    }
    if (entry.tool.destructive === true) destructive = true;
    for (const p of entry.voiceRequiredPermissions) perms.add(p);
  }

  return {
    is_destructive: destructive,
    required_permissions: Array.from(perms).sort(),
    missing,
  };
}

/**
 * Resolve an agent name for a candidate or skill by reading the first
 * available evidence trajectory. Returns `undefined` if no evidence
 * trajectory is retained — the renderer then prints `(unknown)`.
 */
async function resolveAgentName(
  evidenceIds: readonly string[],
  agentTrajectoryIndex: ReadonlyMap<string, string>,
): Promise<string | undefined> {
  for (const id of evidenceIds) {
    const agent = agentTrajectoryIndex.get(id);
    if (agent !== undefined) return agent;
  }
  return undefined;
}

/**
 * Index trajectories by id → agent_name. Built once per command run so
 * we don't re-walk the store per candidate. Trajectories are typically
 * a few hundred per agent in the v0.1 in-memory store; a single full
 * pass is cheap.
 *
 * The store interface only exposes `listTrajectories(agentName)`, so
 * we have to iterate per agent. The score's agent map gives us the
 * list — score.agents is the authoritative set of known agents.
 */
async function indexTrajectoryAgents(
  store: SkillStore,
  score: ScoreConfig,
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const agentName of Object.keys(score.agents)) {
    const trajectories = await store.listTrajectories(agentName);
    for (const t of trajectories) {
      index.set(t.id, t.agent_name);
    }
  }
  return index;
}

/**
 * Build the evidence-sample rows the detail view renders. Caps at
 * three rows — the synthesiser conventionally retains five trajectories
 * per candidate; three keeps the detail screen scannable on a single
 * page.
 */
async function buildEvidenceSamples(
  candidate: SkillCandidate,
  store: SkillStore,
  score: ScoreConfig,
): Promise<EvidenceSample[]> {
  const wanted = new Set(candidate.evidence_trajectory_ids.slice(0, 3));
  if (wanted.size === 0) return [];

  const found = new Map<string, Trajectory>();
  for (const agentName of Object.keys(score.agents)) {
    if (found.size === wanted.size) break;
    const trajectories = await store.listTrajectories(agentName);
    for (const t of trajectories) {
      if (wanted.has(t.id)) found.set(t.id, t);
    }
  }

  const samples: EvidenceSample[] = [];
  for (const id of candidate.evidence_trajectory_ids.slice(0, 3)) {
    const t = found.get(id);
    if (!t) continue;
    samples.push({
      id: t.id,
      outcome: t.outcome,
      toolSequence: t.tool_calls.map((c) => c.tool).join(" → ") || "(no tools)",
    });
  }
  return samples;
}

/* ------------------------------------------------------------------ */
/*  Score + store wiring                                               */
/* ------------------------------------------------------------------ */

/**
 * Shared dependencies for every `skills` subcommand. Built once in the
 * thin command wrappers and passed down so tests can inject an
 * in-process store + a synthetic score without going through
 * `ScoreLoader`.
 */
export interface SkillsContext {
  store: SkillStore;
  score: ScoreConfig;
  /** Sink for human-facing output; defaults to `console.log` in production. */
  out: (line: string) => void;
}

/**
 * Load the score from disk, attach an `InMemorySkillStore`, and warn
 * if persistence isn't configured. Exits the process on score load
 * failure (mirrors `inboxStartCommand`'s contract).
 */
async function loadContext(scorePath: string | undefined): Promise<SkillsContext> {
  const file = resolve(scorePath ?? "./tutti.score.ts");
  if (!existsSync(file)) {
    logger.error({ file }, "Score file not found");
    console.error(chalk.dim('Run "tutti-ai init" to create a new project.'));
    process.exit(1);
  }

  let score: ScoreConfig;
  try {
    score = await ScoreLoader.load(file);
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to load score",
    );
    process.exit(1);
  }

  // The runtime would lazily build one of these if we constructed it
  // with `skills.enabled`; we mirror that here so `skills list` runs
  // without booting the full runner. When the score later wires a
  // persistent store, this is the line that changes.
  const store: SkillStore = new InMemorySkillStore();

  if (!score.skills?.enabled) {
    console.error(
      chalk.yellow(
        "Score has `skills.enabled` unset — proposals and approvals are not currently being recorded.",
      ),
    );
  }
  console.error(
    chalk.dim(
      "[skills] in-memory store: results below are scoped to this process. " +
        "Wire a persistent store on the score for cross-invocation state.",
    ),
  );

  return { store, score, out: (line: string) => console.log(line) };
}

/* ------------------------------------------------------------------ */
/*  list                                                               */
/* ------------------------------------------------------------------ */

/** Thin command wrapper. */
export async function skillsListCommand(scorePath?: string): Promise<void> {
  const ctx = await loadContext(scorePath);
  await runSkillsList(ctx);
}

/** Pure execution path — exercised directly by tests. */
export async function runSkillsList(ctx: SkillsContext): Promise<void> {
  const all = await ctx.store.listSkills();
  const approved = all.filter((s) => s.status === "approved");
  const trajIndex = await indexTrajectoryAgents(ctx.store, ctx.score);
  const agentLookup = new Map<string, string>();
  for (const skill of approved) {
    const name = await resolveAgentName(skill.evidence_trajectory_ids, trajIndex);
    if (name !== undefined) agentLookup.set(skill.id, name);
  }
  ctx.out(renderSkillsList(approved, agentLookup));
}

/* ------------------------------------------------------------------ */
/*  proposed                                                           */
/* ------------------------------------------------------------------ */

export async function skillsProposedCommand(scorePath?: string): Promise<void> {
  const ctx = await loadContext(scorePath);
  await runSkillsProposed(ctx);
}

export async function runSkillsProposed(ctx: SkillsContext): Promise<void> {
  const candidates = await ctx.store.listCandidates();
  const trajIndex = await indexTrajectoryAgents(ctx.store, ctx.score);
  const agentLookup = new Map<string, string>();
  for (const c of candidates) {
    const name = await resolveAgentName(c.evidence_trajectory_ids, trajIndex);
    if (name !== undefined) agentLookup.set(c.id, name);
  }
  ctx.out(renderCandidatesList(candidates, agentLookup));
}

/* ------------------------------------------------------------------ */
/*  reject (non-interactive)                                           */
/* ------------------------------------------------------------------ */

/**
 * Options accepted by the non-interactive reject command. `reviewedBy`
 * mirrors `interrupts deny --by` so the wire-up in `index.ts` stays
 * uniform across commands.
 */
export interface SkillsRejectOptions {
  reason: string;
  reviewedBy?: string;
  scorePath?: string;
}

export async function skillsRejectCommand(
  candidateId: string,
  opts: SkillsRejectOptions,
): Promise<void> {
  const ctx = await loadContext(opts.scorePath);
  const { reviewedBy } = opts;
  await runSkillsReject(
    ctx,
    candidateId,
    reviewedBy !== undefined ? { reason: opts.reason, reviewedBy } : { reason: opts.reason },
  );
}

export async function runSkillsReject(
  ctx: SkillsContext,
  candidateId: string,
  opts: { reason: string; reviewedBy?: string },
): Promise<void> {
  const candidates = await ctx.store.listCandidates();
  const candidate = candidates.find((c) => c.id === candidateId);
  if (!candidate) {
    console.error(chalk.red('No pending candidate with id "' + candidateId + '"'));
    process.exitCode = 1;
    return;
  }
  await ctx.store.rejectCandidate(candidateId, {
    reason: opts.reason,
    ...(opts.reviewedBy !== undefined ? { reviewed_by: opts.reviewedBy } : {}),
  });
  ctx.out(renderRejectedCandidate(candidateId, candidate.name_suggestion, opts.reason));
}

/* ------------------------------------------------------------------ */
/*  review (interactive)                                               */
/* ------------------------------------------------------------------ */

/** Result of one interactive review iteration — used by tests. */
export type ReviewDecision =
  | { kind: "approve"; system_prompt?: string }
  | { kind: "reject"; reason?: string }
  | { kind: "skip" };

/**
 * Pluggable prompt surface — defaults to enquirer in production, easy
 * to stub in tests so we can drive every branch of the review loop
 * without raw-mode stdin. Each method resolves to the operator's
 * chosen value; rejection (Ctrl+C) propagates up so the loop unwinds
 * cleanly.
 */
export interface ReviewPrompts {
  chooseAction(): Promise<"a" | "e" | "r" | "s">;
  editSystemPrompt(initial: string): Promise<string>;
  rejectReason(): Promise<string>;
}

/** Production default — single-character enquirer select + free-text inputs. */
export function defaultReviewPrompts(): ReviewPrompts {
  return {
    async chooseAction(): Promise<"a" | "e" | "r" | "s"> {
      const { action } = await prompt<{ action: string }>({
        type: "select",
        name: "action",
        message: "What would you like to do?",
        choices: [
          { name: "a", message: "approve with default system prompt" },
          { name: "e", message: "edit system prompt and approve" },
          { name: "r", message: "reject" },
          { name: "s", message: "skip" },
        ],
      });
      // enquirer returns the `name` field — narrow before returning.
      if (action === "a" || action === "e" || action === "r" || action === "s") {
        return action;
      }
      // Unreachable in practice; defensive default.
      return "s";
    },
    async editSystemPrompt(initial: string): Promise<string> {
      const { text } = await prompt<{ text: string }>({
        type: "input",
        name: "text",
        message: "System prompt (Enter to keep):",
        initial,
      });
      return text;
    },
    async rejectReason(): Promise<string> {
      const { reason } = await prompt<{ reason: string }>({
        type: "input",
        name: "reason",
        message: "Reason (optional):",
      });
      return reason;
    },
  };
}

/**
 * Apply a single review decision to the store. Split from the prompt
 * loop so tests can drive every branch (approve / edit-then-approve /
 * reject / skip / blocked-by-missing-tool) without an interactive
 * session.
 *
 * Returns `"applied"` when the store was mutated, `"skipped"` when the
 * decision was skip, or `"blocked"` when approval was attempted with
 * unresolved constituents.
 */
export async function applyReviewDecision(
  ctx: SkillsContext,
  candidate: SkillCandidate,
  resolution: ConstituentResolution,
  decision: ReviewDecision,
  reviewedBy?: string,
): Promise<"applied" | "skipped" | "blocked"> {
  if (decision.kind === "skip") {
    ctx.out(chalk.dim("Skipped " + candidate.name_suggestion + "."));
    return "skipped";
  }
  if (decision.kind === "reject") {
    await ctx.store.rejectCandidate(candidate.id, {
      ...(decision.reason !== undefined && decision.reason.trim() !== ""
        ? { reason: decision.reason.trim() }
        : {}),
      ...(reviewedBy !== undefined ? { reviewed_by: reviewedBy } : {}),
    });
    ctx.out(
      renderRejectedCandidate(
        candidate.id,
        candidate.name_suggestion,
        decision.reason && decision.reason.trim() !== "" ? decision.reason.trim() : undefined,
      ),
    );
    return "applied";
  }
  // approve
  if (resolution.missing.length > 0) {
    console.error(
      chalk.red(
        "Cannot approve — these constituent tools no longer exist in the score: " +
          resolution.missing.join(", ") +
          ".",
      ),
    );
    console.error(
      chalk.dim(
        "  Add the voice back to an agent, or reject this candidate with `tutti-ai skills reject " +
          candidate.id +
          ' --reason "..."`.',
      ),
    );
    return "blocked";
  }
  const skill = await ctx.store.approveCandidate(candidate.id, {
    is_destructive: resolution.is_destructive,
    required_permissions: [...resolution.required_permissions],
    ...(decision.system_prompt !== undefined ? { system_prompt: decision.system_prompt } : {}),
    ...(reviewedBy !== undefined ? { reviewed_by: reviewedBy } : {}),
  });
  ctx.out(renderApprovedSkill(skill));
  return "applied";
}

/** Options accepted by `tutti-ai skills review`. */
export interface SkillsReviewOptions {
  scorePath?: string;
  reviewedBy?: string;
}

export async function skillsReviewCommand(
  candidateId: string | undefined,
  opts: SkillsReviewOptions = {},
): Promise<void> {
  const ctx = await loadContext(opts.scorePath);
  await runSkillsReview(ctx, candidateId, defaultReviewPrompts(), opts.reviewedBy);
}

/**
 * Walk the pending candidates one by one (or one specific candidate
 * when `candidateId` is set). Exits when:
 *   - all candidates handled
 *   - operator skips a candidate (continue to next)
 *   - operator approves/rejects (continue to next)
 *   - operator hits Ctrl+C (enquirer rejects the prompt promise; we
 *     swallow and exit cleanly)
 */
export async function runSkillsReview(
  ctx: SkillsContext,
  candidateId: string | undefined,
  prompts: ReviewPrompts,
  reviewedBy?: string,
): Promise<void> {
  const all = await ctx.store.listCandidates();
  const queue =
    candidateId !== undefined ? all.filter((c) => c.id === candidateId) : all;

  if (queue.length === 0) {
    if (candidateId !== undefined) {
      console.error(chalk.red('No pending candidate with id "' + candidateId + '"'));
      process.exitCode = 1;
      return;
    }
    ctx.out(chalk.dim("No pending skill candidates to review."));
    return;
  }

  const catalogue = buildToolCatalogue(ctx.score);
  const trajIndex = await indexTrajectoryAgents(ctx.store, ctx.score);

  for (let i = 0; i < queue.length; i++) {
    const candidate = queue[i];
    if (!candidate) continue; // noUncheckedIndexedAccess
    ctx.out(renderReviewHeading(queue.length, i + 1));
    const resolution = resolveConstituents(candidate, catalogue);
    const agentName = await resolveAgentName(
      candidate.evidence_trajectory_ids,
      trajIndex,
    );
    const evidence = await buildEvidenceSamples(candidate, ctx.store, ctx.score);
    ctx.out(renderCandidateDetail(candidate, agentName, resolution, evidence));

    let action: "a" | "e" | "r" | "s";
    try {
      action = await prompts.chooseAction();
    } catch {
      // Enquirer rejects on Ctrl+C — treat as graceful exit, not error.
      ctx.out(chalk.dim("Review cancelled."));
      return;
    }

    let decision: ReviewDecision;
    if (action === "a") {
      decision = { kind: "approve" };
    } else if (action === "e") {
      let edited: string;
      try {
        edited = await prompts.editSystemPrompt(candidate.description);
      } catch {
        ctx.out(chalk.dim("Review cancelled."));
        return;
      }
      decision =
        edited.trim() !== "" && edited !== candidate.description
          ? { kind: "approve", system_prompt: edited }
          : { kind: "approve" };
    } else if (action === "r") {
      let reason: string;
      try {
        reason = await prompts.rejectReason();
      } catch {
        ctx.out(chalk.dim("Review cancelled."));
        return;
      }
      decision = reason.trim() !== "" ? { kind: "reject", reason } : { kind: "reject" };
    } else {
      decision = { kind: "skip" };
    }

    await applyReviewDecision(ctx, candidate, resolution, decision, reviewedBy);
  }
}
