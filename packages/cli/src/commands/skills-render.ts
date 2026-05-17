/**
 * Pure rendering functions for the `tutti-ai skills` command.
 *
 * Split from `skills.ts` so they stay under coverage while the
 * score-loading, raw-stdin, and enquirer-driven review loop stay
 * excluded (same convention as `interrupts.ts` / `interrupts-render.ts`).
 *
 * Every function is deterministic, takes its inputs by argument, and
 * returns a string — no globals, no side effects, no `chalk.level`
 * mutation. Tests strip ANSI before asserting so colour escapes do not
 * leak into assertions.
 */

import chalk from "chalk";
import { z } from "zod";
import type { Skill, SkillCandidate } from "@tuttiai/skills";

/** Visible width of an ANSI-coloured string. */
function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "").length;
}

/** Right-pad to `len` accounting for ANSI escape sequences. */
function pad(s: string, len: number): string {
  const v = visibleLen(s);
  return v >= len ? s : s + " ".repeat(len - v);
}

/** Truncate text to `max` chars, appending `…` when cut. */
function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/** `YYYY-MM-DD HH:MM:SS` UTC string — used in headings and detail views. */
function formatIsoShort(d: Date): string {
  const iso = d.toISOString();
  return iso.slice(0, 10) + " " + iso.slice(11, 19);
}

/**
 * Best-effort one-line summary of a Zod input schema. Lists object keys
 * when the root is a `ZodObject`; falls back to `<schema>` otherwise.
 * Operators care about which fields the skill takes, not their exact
 * types — those live in the description.
 */
export function summariseInputSchema(schema: z.ZodTypeAny): string {
  // Duck-type rather than instanceof — the Zod version the runtime
  // uses may differ from the CLI's, so `instanceof z.ZodObject` is
  // unreliable across realms.
  const def = (schema as { _def?: { typeName?: string } })._def;
  if (def?.typeName === "ZodObject") {
    const shape = (schema as unknown as { shape: Record<string, unknown> }).shape;
    const keys = Object.keys(shape);
    if (keys.length === 0) return "{} (no fields)";
    return "{ " + keys.join(", ") + " }";
  }
  return "<" + (def?.typeName ?? "schema") + ">";
}

/* ------------------------------------------------------------------ */
/*  Approved skills list                                               */
/* ------------------------------------------------------------------ */

/**
 * Render the approved-skills table. `agentLookup` maps a skill id to a
 * human-readable agent name (resolved from the first evidence
 * trajectory by the caller); a missing entry renders as `(unknown)` so
 * the column stays aligned when trajectories have been evicted.
 *
 * Renders rejected skills too — they have `status: "rejected"` and
 * carry the same shape as approved ones — but only in the
 * non-filtered API; `skills list` filters to `status === "approved"`
 * before calling here.
 */
export function renderSkillsList(
  skills: readonly Skill[],
  agentLookup: ReadonlyMap<string, string>,
): string {
  if (skills.length === 0) {
    return chalk.dim("No approved skills yet.");
  }

  const lines: string[] = [];
  lines.push("");
  lines.push(
    chalk.dim(
      "  " +
        pad("NAME", 26) +
        pad("AGENT", 18) +
        pad("DESTRUCTIVE", 13) +
        "APPROVED",
    ),
  );
  lines.push(chalk.dim("  " + "─".repeat(80)));

  for (const skill of skills) {
    const name = truncate(skill.name_suggestion, 24);
    const agent = agentLookup.get(skill.id) ?? "(unknown)";
    const destructive = skill.is_destructive
      ? chalk.red("yes")
      : chalk.dim("no");
    const approved = formatIsoShort(skill.reviewed_at);
    lines.push(
      "  " +
        pad(chalk.cyan(name), 26) +
        pad(agent, 18) +
        pad(destructive, 13) +
        chalk.dim(approved),
    );
  }
  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Pending candidates list                                            */
/* ------------------------------------------------------------------ */

/**
 * Render the pending-candidates table. `agentLookup` maps a candidate
 * id to a human-readable agent name; missing entries fall back to
 * `(unknown)` for the same reason as {@link renderSkillsList}.
 */
export function renderCandidatesList(
  candidates: readonly SkillCandidate[],
  agentLookup: ReadonlyMap<string, string>,
): string {
  if (candidates.length === 0) {
    return chalk.dim("No pending skill candidates.");
  }

  const lines: string[] = [];
  lines.push("");
  lines.push(
    chalk.dim(
      "  " +
        pad("ID", 10) +
        pad("NAME", 26) +
        pad("AGENT", 18) +
        pad("EVIDENCE", 10) +
        "PROPOSED",
    ),
  );
  lines.push(chalk.dim("  " + "─".repeat(85)));

  for (const c of candidates) {
    const idShort = c.id.slice(0, 8);
    const name = truncate(c.name_suggestion, 24);
    const agent = agentLookup.get(c.id) ?? "(unknown)";
    const evidence = String(c.evidence_trajectory_ids.length);
    const proposed = formatIsoShort(c.proposed_at);
    lines.push(
      "  " +
        chalk.bold(pad(idShort, 10)) +
        pad(chalk.cyan(name), 26) +
        pad(agent, 18) +
        pad(chalk.dim(evidence), 10) +
        chalk.dim(proposed),
    );
  }
  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Candidate detail (for interactive review)                          */
/* ------------------------------------------------------------------ */

/**
 * One row of evidence the operator sees while reviewing — derived from
 * a stored {@link Trajectory} by the caller. Strings only so this
 * render module stays free of any `Trajectory` import.
 */
export interface EvidenceSample {
  /** Short trajectory id. */
  id: string;
  /** `success` | `failure` | `unknown`. */
  outcome: string;
  /** Comma-joined tool names, in invocation order. */
  toolSequence: string;
}

/**
 * Resolution summary for a candidate's constituent tools — produced by
 * the caller's catalogue lookup. `missing` is non-empty when one or
 * more constituent tool names no longer correspond to a loaded voice
 * tool. The detail view renders this so the operator can see *why*
 * approval is blocked before being prompted for an action.
 */
export interface ConstituentResolution {
  is_destructive: boolean;
  required_permissions: readonly string[];
  missing: readonly string[];
}

/**
 * Detail view for a single candidate. Shown before the action prompt
 * in interactive review and as the body of `skills review <id>`.
 */
export function renderCandidateDetail(
  candidate: SkillCandidate,
  agentName: string | undefined,
  resolution: ConstituentResolution,
  evidence: readonly EvidenceSample[],
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold("Skill candidate ") + chalk.dim(candidate.id));
  lines.push(chalk.dim("─".repeat(60)));
  lines.push(chalk.dim("Name:        ") + chalk.cyan(candidate.name_suggestion));
  lines.push(chalk.dim("Agent:       ") + (agentName ?? chalk.dim("(unknown)")));
  lines.push(chalk.dim("Proposed:    ") + formatIsoShort(candidate.proposed_at));
  lines.push("");
  lines.push(chalk.dim("Description:"));
  for (const line of candidate.description.split(/\r?\n/)) {
    lines.push("  " + line);
  }
  lines.push("");
  lines.push(chalk.dim("Input:       ") + summariseInputSchema(candidate.signature.input));
  lines.push(
    chalk.dim("Output:      ") +
      (candidate.signature.output
        ? summariseInputSchema(candidate.signature.output)
        : chalk.dim("(effectful, no output)")),
  );
  lines.push("");
  lines.push(
    chalk.dim("Constituent tools: ") +
      candidate.constituent_tools.map((t) => chalk.cyan(t)).join(", "),
  );
  lines.push(
    chalk.dim("Destructive:       ") +
      (resolution.is_destructive ? chalk.red("yes") : chalk.dim("no")),
  );
  lines.push(
    chalk.dim("Permissions:       ") +
      (resolution.required_permissions.length === 0
        ? chalk.dim("(none)")
        : resolution.required_permissions.join(", ")),
  );
  if (resolution.missing.length > 0) {
    lines.push("");
    lines.push(
      chalk.red(
        "⚠ Cannot approve — constituent tools no longer exist in the score:",
      ),
    );
    for (const name of resolution.missing) {
      lines.push("    - " + chalk.red(name));
    }
    lines.push(
      chalk.dim(
        "    Add the voice back to an agent in the score, or reject this candidate.",
      ),
    );
  }
  lines.push("");
  lines.push(chalk.dim("Evidence (sampled, " + evidence.length + " of " + candidate.evidence_trajectory_ids.length + "):"));
  if (evidence.length === 0) {
    lines.push(chalk.dim("  (trajectories not retained)"));
  } else {
    for (const ev of evidence) {
      lines.push(
        "  " +
          chalk.dim(ev.id.slice(0, 8)) +
          " " +
          colourOutcome(ev.outcome) +
          chalk.dim("  ") +
          truncate(ev.toolSequence, 80),
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

function colourOutcome(outcome: string): string {
  if (outcome === "success") return chalk.green(pad(outcome, 8));
  if (outcome === "failure") return chalk.red(pad(outcome, 8));
  return chalk.dim(pad(outcome, 8));
}

/* ------------------------------------------------------------------ */
/*  Confirmation lines                                                 */
/* ------------------------------------------------------------------ */

/** One-line confirmation printed after a successful approve. */
export function renderApprovedSkill(skill: Skill): string {
  const destructive = skill.is_destructive ? chalk.red(" (destructive)") : "";
  return (
    chalk.green("✓") +
    " Approved " +
    chalk.bold(skill.name_suggestion) +
    chalk.dim(" [" + skill.id.slice(0, 8) + "]") +
    destructive
  );
}

/** One-line confirmation printed after a successful reject. */
export function renderRejectedCandidate(
  candidateId: string,
  candidateName: string,
  reason?: string,
): string {
  return (
    chalk.red("✗") +
    " Rejected " +
    chalk.bold(candidateName) +
    chalk.dim(" [" + candidateId.slice(0, 8) + "]") +
    (reason ? chalk.dim(' — "' + reason + '"') : "")
  );
}

/** Heading printed at the top of `skills review` walks. */
export function renderReviewHeading(total: number, index: number): string {
  return chalk.bold("Reviewing candidate ") + chalk.dim(index + " of " + total);
}
