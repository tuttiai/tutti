/**
 * Unit tests for the context shortening primitives: estimating, capping and
 * trimming tool results.
 */

import { describe, it, expect } from "vitest";
import type { ChatMessage, ToolResultBlock } from "@tuttiai/types";

import { capText, capToolResults, estimateTokens, trimToolResults } from "../../src/context/trim.js";
import { PromptGuard } from "../../src/prompt-guard.js";

function result(id: string, content: string): ToolResultBlock {
  return { type: "tool_result", tool_use_id: id, content };
}

function conversation(...contents: string[]): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: "Task" }];
  contents.forEach((content, i) => {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${String(i)}`, name: "read", input: {} }] });
    messages.push({ role: "user", content: [result(`t${String(i)}`, content)] });
  });
  return messages;
}

function resultAt(messages: ChatMessage[], index: number): string {
  const content = messages.at(index)?.content;
  const block = Array.isArray(content) ? content.at(0) : undefined;
  return block?.type === "tool_result" ? block.content : "";
}

describe("estimateTokens", () => {
  it("counts about one token per four characters", () => {
    expect(estimateTokens([{ role: "user", content: "x".repeat(398) }])).toBe(100);
  });
});

describe("capText", () => {
  it("leaves text that fits unchanged", () => {
    expect(capText("short", 10)).toBe("short");
  });

  it("keeps the start and the end and says how much was left out", () => {
    const capped = capText(`${"a".repeat(100)}${"b".repeat(100)}`, 100);
    expect(capped.startsWith("a".repeat(70))).toBe(true);
    expect(capped.endsWith("b".repeat(30))).toBe(true);
    expect(capped).toContain("100 characters left out");
  });
});

describe("capToolResults", () => {
  it("caps each result and keeps its id and error flag", () => {
    const [capped] = capToolResults([{ ...result("t1", "x".repeat(50)), is_error: true }], 10);
    expect(capped).toMatchObject({ tool_use_id: "t1", is_error: true });
    expect(capped?.content).toContain("left out");
  });
});

describe("trimToolResults", () => {
  it("shortens every result but the most recent ones", () => {
    const messages = conversation("a".repeat(1000), "b".repeat(1000), "c".repeat(1000));
    const removed = trimToolResults(messages, 1, 100);
    expect(removed).toBeGreaterThan(1200);
    expect(resultAt(messages, 2)).toMatch(/^a{100}\n\[Shortened/);
    expect(resultAt(messages, 4)).toMatch(/^b{100}\n\[Shortened/);
    expect(resultAt(messages, 6)).toBe("c".repeat(1000));
  });

  it("keeps PromptGuard's closing fence on a shortened result", () => {
    const wrapped = PromptGuard.wrap("read", "x".repeat(5_000));
    const messages = conversation(wrapped, "recent");
    trimToolResults(messages, 1, 100);
    expect(resultAt(messages, 2)).toContain("[Shortened");
    expect(resultAt(messages, 2)).toContain("[END TOOL RESULT]");
    expect(resultAt(messages, 2).endsWith(wrapped.slice(-40))).toBe(true);
  });

  it("rewrites nothing on a second pass, so a cached prefix stays valid", () => {
    const messages = conversation("a".repeat(1000), "b".repeat(1000));
    trimToolResults(messages, 1, 100);
    const after = JSON.stringify(messages);
    expect(trimToolResults(messages, 1, 100)).toBe(0);
    expect(JSON.stringify(messages)).toBe(after);
  });

  it("leaves short results alone", () => {
    const messages = conversation("tiny", "also tiny");
    expect(trimToolResults(messages, 0, 100)).toBe(0);
  });

  it("replaces messages rather than editing them, so a caller's copy is untouched", () => {
    const messages = conversation("a".repeat(1000), "b".repeat(1000));
    const original = messages.at(2);
    trimToolResults(messages, 1, 100);
    expect(messages.at(2)).not.toBe(original);
    expect(JSON.stringify(original)).toContain("a".repeat(1000));
  });
});
