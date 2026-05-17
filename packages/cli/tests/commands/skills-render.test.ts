/**
 * Tests for the pure rendering functions of `tutti-ai skills`. The
 * interactive command itself is excluded from coverage; these tests
 * keep render output under coverage thresholds and pin the layout so
 * accidental shifts surface in CI.
 */

import { describe, expect, it } from "vitest";
import chalk from "chalk";
import { z } from "zod";
import type { Skill, SkillCandidate } from "@tuttiai/skills";

import {
  renderApprovedSkill,
  renderCandidateDetail,
  renderCandidatesList,
  renderRejectedCandidate,
  renderReviewHeading,
  renderSkillsList,
  summariseInputSchema,
  type ConstituentResolution,
  type EvidenceSample,
} from "../../src/commands/skills-render.js";

chalk.level = 1;

/* eslint-disable no-control-regex */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
/* eslint-enable no-control-regex */

function mkCandidate(overrides: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    id: "cand-12345678",
    name_suggestion: "Summarise inbox",
    description: "Summarise the inbox into bullet points.",
    signature: { input: z.object({ since: z.string(), limit: z.number().optional() }) },
    constituent_tools: ["read_email", "search_inbox"],
    evidence_trajectory_ids: ["traj-1", "traj-2", "traj-3", "traj-4", "traj-5"],
    proposed_at: new Date("2026-05-17T10:00:00Z"),
    ...overrides,
  };
}

function mkSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    ...mkCandidate(),
    status: "approved",
    reviewed_at: new Date("2026-05-17T10:05:00Z"),
    is_destructive: false,
    required_permissions: [],
    ...overrides,
  };
}

const emptyResolution: ConstituentResolution = {
  is_destructive: false,
  required_permissions: [],
  missing: [],
};

/* ------------------------------------------------------------------ */
/*  summariseInputSchema                                               */
/* ------------------------------------------------------------------ */

describe("summariseInputSchema", () => {
  it("lists keys for a ZodObject", () => {
    const s = summariseInputSchema(z.object({ a: z.string(), b: z.number() }));
    expect(s).toBe("{ a, b }");
  });

  it("returns a placeholder for empty objects", () => {
    expect(summariseInputSchema(z.object({}))).toBe("{} (no fields)");
  });

  it("falls back for non-object schemas", () => {
    const out = summariseInputSchema(z.string());
    expect(out.startsWith("<")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  renderSkillsList                                                   */
/* ------------------------------------------------------------------ */

describe("renderSkillsList", () => {
  it("empty → friendly message", () => {
    expect(stripAnsi(renderSkillsList([], new Map()))).toContain("No approved skills yet.");
  });

  it("renders headers, names, destructive flag, and approved date", () => {
    const skill = mkSkill({ name_suggestion: "Triage", is_destructive: true });
    const out = stripAnsi(renderSkillsList([skill], new Map([[skill.id, "assistant"]])));
    expect(out).toContain("NAME");
    expect(out).toContain("AGENT");
    expect(out).toContain("DESTRUCTIVE");
    expect(out).toContain("APPROVED");
    expect(out).toContain("Triage");
    expect(out).toContain("assistant");
    expect(out).toContain("yes");
    expect(out).toContain("2026-05-17 10:05:00");
  });

  it('falls back to "(unknown)" when no agent is resolved', () => {
    const skill = mkSkill();
    const out = stripAnsi(renderSkillsList([skill], new Map()));
    expect(out).toContain("(unknown)");
  });
});

/* ------------------------------------------------------------------ */
/*  renderCandidatesList                                               */
/* ------------------------------------------------------------------ */

describe("renderCandidatesList", () => {
  it("empty → friendly message", () => {
    expect(stripAnsi(renderCandidatesList([], new Map()))).toContain(
      "No pending skill candidates.",
    );
  });

  it("shows id (short), name, evidence count, proposed date", () => {
    const c = mkCandidate({ id: "cand-abcdef0123" });
    const out = stripAnsi(renderCandidatesList([c], new Map([[c.id, "assistant"]])));
    expect(out).toContain("cand-abc"); // first 8 chars
    expect(out).toContain("Summarise inbox");
    expect(out).toContain("5"); // evidence count
    expect(out).toContain("2026-05-17 10:00:00");
  });
});

/* ------------------------------------------------------------------ */
/*  renderCandidateDetail                                              */
/* ------------------------------------------------------------------ */

describe("renderCandidateDetail", () => {
  it("renders every block: name, agent, description, signature, constituents, evidence", () => {
    const c = mkCandidate();
    const evidence: EvidenceSample[] = [
      { id: "traj-1", outcome: "success", toolSequence: "read_email → search_inbox" },
      { id: "traj-2", outcome: "failure", toolSequence: "read_email" },
    ];
    const resolution: ConstituentResolution = {
      is_destructive: true,
      required_permissions: ["network"],
      missing: [],
    };
    const out = stripAnsi(renderCandidateDetail(c, "assistant", resolution, evidence));
    expect(out).toContain("Skill candidate cand-12345678");
    expect(out).toContain("Summarise inbox");
    expect(out).toContain("assistant");
    expect(out).toContain("Summarise the inbox into bullet points.");
    expect(out).toContain("{ since, limit }");
    expect(out).toContain("read_email");
    expect(out).toContain("search_inbox");
    expect(out).toContain("Destructive:       yes");
    expect(out).toContain("network");
    expect(out).toContain("Evidence (sampled, 2 of 5):");
    expect(out).toContain("read_email → search_inbox");
  });

  it("surfaces missing constituents with an actionable hint", () => {
    const c = mkCandidate();
    const resolution: ConstituentResolution = {
      is_destructive: false,
      required_permissions: [],
      missing: ["removed_tool"],
    };
    const out = stripAnsi(renderCandidateDetail(c, "assistant", resolution, []));
    expect(out).toContain("Cannot approve");
    expect(out).toContain("removed_tool");
    expect(out).toContain("reject this candidate");
  });

  it("handles empty evidence with a clear placeholder", () => {
    const c = mkCandidate({ evidence_trajectory_ids: [] });
    const out = stripAnsi(renderCandidateDetail(c, undefined, emptyResolution, []));
    expect(out).toContain("(trajectories not retained)");
    expect(out).toContain("(unknown)");
  });
});

/* ------------------------------------------------------------------ */
/*  Confirmation lines                                                 */
/* ------------------------------------------------------------------ */

describe("renderApprovedSkill / renderRejectedCandidate / renderReviewHeading", () => {
  it("renderApprovedSkill marks destructive skills", () => {
    const skill = mkSkill({ is_destructive: true });
    const out = stripAnsi(renderApprovedSkill(skill));
    expect(out).toContain("Approved Summarise inbox");
    expect(out).toContain("(destructive)");
  });

  it("renderRejectedCandidate includes the reason when supplied", () => {
    const out = stripAnsi(renderRejectedCandidate("cand-12345678", "Some name", "duplicate"));
    expect(out).toContain("Rejected Some name");
    expect(out).toContain("cand-123");
    expect(out).toContain("duplicate");
  });

  it("renderRejectedCandidate works without a reason", () => {
    const out = stripAnsi(renderRejectedCandidate("cand-12345678", "Some name"));
    expect(out).toContain("Rejected Some name");
  });

  it("renderReviewHeading formats counts", () => {
    expect(stripAnsi(renderReviewHeading(3, 1))).toContain("1 of 3");
  });
});
