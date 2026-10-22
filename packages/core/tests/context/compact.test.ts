/**
 * Unit tests for `compactContext`: it shortens a conversation in steps, so the
 * calls between two shortenings send an unchanged history (ADR-0026).
 */

import { describe, it, expect, vi } from "vitest";
import type { ChatMessage } from "@tuttiai/types";

import { compactContext } from "../../src/context/compact.js";
import { estimateTokens } from "../../src/context/trim.js";

function addTurn(messages: ChatMessage[], i: number, chars: number): void {
  messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${String(i)}`, name: "read", input: {} }] });
  messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${String(i)}`, content: "x".repeat(chars) }] });
}

const deps = { agent_name: "dev", chat: vi.fn() };

describe("compactContext", () => {
  it("rewrites the history in steps, not on every turn over the threshold", async () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Task" }];
    const config = { trim_after_tokens: 40_000, keep_recent_tool_results: 4 };
    let rewrites = 0;
    // Twenty results of about 12,000 tokens: the four kept whole are already over the threshold,
    // so before ADR-0026 every turn from the fourth rewrote the history (16 rewrites).
    for (let i = 0; i < 20; i++) {
      addTurn(messages, i, 48_000);
      const before = JSON.stringify(messages);
      await compactContext(messages, config, deps);
      if (JSON.stringify(messages) !== before) rewrites++;
    }
    expect(rewrites).toBeGreaterThan(0);
    expect(rewrites).toBeLessThanOrEqual(10);
    expect(estimateTokens(messages)).toBeLessThan(40_000 * 1.5);
  });

  it("trims at once the first time a conversation is over the threshold", async () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Task" }];
    for (let i = 0; i < 3; i++) addTurn(messages, i, 8_000);
    await compactContext(messages, { trim_after_tokens: 1_000, keep_recent_tool_results: 1 }, deps);
    expect(JSON.stringify(messages)).toContain("Shortened to save context");
  });

  it("does not summarise again on the next turn when the summary left it over the threshold", async () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Task" }];
    for (let i = 0; i < 4; i++) addTurn(messages, i, 4_000);
    const chat = vi.fn().mockResolvedValue({
      id: "s",
      content: [{ type: "text", text: "summary" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const config = { summarise_after_tokens: 1_000, keep_recent_messages: 2 };
    await compactContext(messages, config, { agent_name: "dev", chat });
    addTurn(messages, 4, 100);
    await compactContext(messages, config, { agent_name: "dev", chat });
    expect(chat).toHaveBeenCalledTimes(1);
  });
});
