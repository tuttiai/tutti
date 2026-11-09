import { describe, it, expect } from "vitest";

import {
  formatSemanticMemories,
  formatUserMemories,
  importanceLabel,
  parseInferredMemories,
  renderProfileForPrompt,
} from "../../src/runner/memory-format.js";
import { emptyProfile, type UserProfile } from "../../src/memory/user-model.js";
import type { UserMemory } from "../../src/memory/user/types.js";
import type { MemoryEntry } from "../../src/memory/semantic.js";

const profile = (over: Partial<UserProfile>): UserProfile => ({ ...emptyProfile("u1"), ...over });

const userMemory = (content: string, importance: 1 | 2 | 3): UserMemory => ({
  id: content,
  user_id: "u1",
  content,
  source: "explicit",
  importance,
  created_at: new Date(0),
});

const entry = (content: string): MemoryEntry => ({
  id: content,
  agent_name: "a",
  content,
  metadata: {},
  created_at: new Date(0),
});

describe("renderProfileForPrompt", () => {
  it("returns an empty string for a bootstrap-empty profile", () => {
    expect(renderProfileForPrompt(emptyProfile("u1"))).toBe("");
  });

  it("treats a whitespace-only summary as empty", () => {
    expect(renderProfileForPrompt(profile({ summary: "   " }))).toBe("");
  });

  it("renders a summary-only profile, trimmed", () => {
    expect(renderProfileForPrompt(profile({ summary: "  Likes tea. " }))).toBe(
      "\n\nUser profile:\nLikes tea.",
    );
  });

  it("renders preferences only", () => {
    expect(renderProfileForPrompt(profile({ preferences: { tone: "terse" } }))).toBe(
      "\n\nUser profile:\nKnown preferences:\n- tone: terse",
    );
  });

  it("renders projects only", () => {
    expect(renderProfileForPrompt(profile({ ongoing_projects: ["tutti"] }))).toBe(
      "\n\nUser profile:\nOngoing projects:\n- tutti",
    );
  });

  it("renders all three sections in order", () => {
    const out = renderProfileForPrompt(
      profile({ summary: "S", preferences: { a: "1" }, ongoing_projects: ["p"] }),
    );
    expect(out).toBe("\n\nUser profile:\nS\nKnown preferences:\n- a: 1\nOngoing projects:\n- p");
  });
});

describe("importanceLabel", () => {
  it("maps each importance to its label", () => {
    expect(importanceLabel(1)).toBe("low");
    expect(importanceLabel(2)).toBe("normal");
    expect(importanceLabel(3)).toBe("high");
  });
});

describe("formatUserMemories", () => {
  it("returns an empty string for no memories", () => {
    expect(formatUserMemories([])).toBe("");
  });

  it("lists each memory with its importance label", () => {
    const out = formatUserMemories([userMemory("Prefers UK English", 3), userMemory("Has a cat", 1)]);
    expect(out).toBe(
      "\n\nWhat I remember about you:\n" +
        "- Prefers UK English [importance: high]\n- Has a cat [importance: low]",
    );
  });
});

describe("formatSemanticMemories", () => {
  const hint =
    "\n\nUse the `remember` tool when the user shares something worth keeping. " +
    "Use `recall` to look things up. " +
    "Use `forget` to remove an entry the user retracts.";

  it("returns an empty string for no memories, even with the hint on", () => {
    expect(formatSemanticMemories([], true)).toBe("");
  });

  it("renders the block without the hint when curated tools are off", () => {
    expect(formatSemanticMemories([entry("one"), entry("two")], false)).toBe(
      "\n\nRelevant context from previous sessions:\n- one\n- two",
    );
  });

  it("appends the curated-tools hint when curated tools are on", () => {
    expect(formatSemanticMemories([entry("one")], true)).toBe(
      "\n\nRelevant context from previous sessions:\n- one" + hint,
    );
  });
});

describe("parseInferredMemories", () => {
  it("returns [] for empty text", () => {
    expect(parseInferredMemories("")).toEqual([]);
  });

  it("parses a bare JSON array", () => {
    expect(parseInferredMemories('["User likes tea."]')).toEqual(["User likes tea."]);
  });

  it("parses a code-fenced reply", () => {
    expect(parseInferredMemories('```json\n["User likes tea."]\n```')).toEqual(["User likes tea."]);
  });

  it("ignores prose around the array", () => {
    expect(parseInferredMemories('Here you go: ["User A."] Hope it helps')).toEqual(["User A."]);
  });

  it("returns [] for invalid JSON", () => {
    expect(parseInferredMemories("[not json]")).toEqual([]);
  });

  it("returns [] when there is no array", () => {
    expect(parseInferredMemories('{"a": 1}')).toEqual([]);
    expect(parseInferredMemories("] backwards [")).toEqual([]);
  });

  it("returns [] for an array with no strings", () => {
    expect(parseInferredMemories("[1, 2, {}]")).toEqual([]);
  });

  it("keeps only non-empty strings, trimmed", () => {
    expect(parseInferredMemories('["  User B.  ", 3, null, "", "   ", "User C."]')).toEqual([
      "User B.",
      "User C.",
    ]);
  });
});
