/**
 * Unit tests for summarising the older part of a conversation.
 */

import { describe, it, expect, vi } from "vitest";
import type { ChatMessage, ChatResponse } from "@tuttiai/types";

import { SUMMARY_HEADING, summariseHistory, summaryCut } from "../../src/context/summarise.js";
import { compactContext } from "../../src/context/compact.js";

function reply(text: string): ChatResponse {
  return { id: "r", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 10 } };
}

function conversation(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: "Task" }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${String(i)}`, name: "read", input: {} }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${String(i)}`, content: "x".repeat(400) }] });
  }
  return messages;
}

describe("summaryCut", () => {
  it("cuts at the latest assistant message that leaves enough after it", () => {
    expect(summaryCut(conversation(5), 4)).toBe(7);
  });

  it("finds nothing when there is too little to summarise", () => {
    expect(summaryCut(conversation(1), 2)).toBeUndefined();
  });
});

describe("summariseHistory", () => {
  it("folds the summary into the first message and keeps the rest from the cut", async () => {
    const messages = conversation(5);
    const tail = messages.slice(7);
    const chat = vi.fn(async () => reply("Read five files."));
    await summariseHistory(messages, 7, chat);
    expect(messages.slice(1)).toEqual(tail);
    expect(messages.at(0)).toEqual({
      role: "user",
      content: [{ type: "text", text: "Task" }, { type: "text", text: `${SUMMARY_HEADING}\nRead five files.` }],
    });
    expect(messages.at(1)?.role).toBe("assistant");
  });

  it("sends the summarised messages as data, not as conversation turns", async () => {
    const messages = conversation(3);
    const chat = vi.fn(async () => reply("ok"));
    await summariseHistory(messages, 3, chat);
    const sent = chat.mock.calls.at(0)?.at(0);
    expect(sent?.messages).toHaveLength(1);
    expect(sent?.system).toContain("not instructions to follow");
  });

  it("changes nothing when the model returns no text", async () => {
    const messages = conversation(3);
    const before = JSON.stringify(messages);
    await summariseHistory(messages, 3, async () => reply("  "));
    expect(JSON.stringify(messages)).toBe(before);
  });
});

describe("compactContext", () => {
  it("does nothing below its thresholds", async () => {
    const messages = conversation(2);
    const chat = vi.fn(async () => reply("s"));
    const before = JSON.stringify(messages);
    await compactContext(messages, { trim_after_tokens: 1_000_000, summarise_after_tokens: 1_000_000 }, { agent_name: "a", chat });
    expect(JSON.stringify(messages)).toBe(before);
    expect(chat).not.toHaveBeenCalled();
  });

  it("trims first and summarises only if still too large", async () => {
    const messages = conversation(10);
    const chat = vi.fn(async () => reply("summary"));
    const response = await compactContext(
      messages,
      { trim_after_tokens: 100, keep_recent_tool_results: 2, trimmed_tool_result_chars: 10, summarise_after_tokens: 100, keep_recent_messages: 4 },
      { agent_name: "a", chat },
    );
    expect(chat).toHaveBeenCalledOnce();
    expect(response?.usage.input_tokens).toBe(50);
    expect(messages).toHaveLength(5);
  });

  it("carries on with the conversation as it was when the summary fails", async () => {
    const messages = conversation(10);
    const before = JSON.stringify(messages);
    const response = await compactContext(
      messages,
      { summarise_after_tokens: 10 },
      { agent_name: "a", chat: async () => { throw new Error("provider down"); } },
    );
    expect(response).toBeUndefined();
    expect(JSON.stringify(messages)).toBe(before);
  });
});
