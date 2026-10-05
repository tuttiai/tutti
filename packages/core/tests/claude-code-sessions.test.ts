/**
 * Unit tests for {@link ClaudeCodeSessions}: which conversation a Claude Code
 * session holds, and when it may be resumed.
 */

import { describe, it, expect } from "vitest";
import type { ChatRequest, ContentBlock } from "@tuttiai/types";

import { ClaudeCodeSessions } from "../src/providers/claude-code-sessions.js";

const first: ChatRequest = { model: "m", system: "s", messages: [{ role: "user", content: "Hi" }] };
const reply: ContentBlock[] = [{ type: "text", text: "Hello" }];
const next: ChatRequest = {
  ...first,
  messages: [...first.messages, { role: "assistant", content: reply }, { role: "user", content: "More" }],
};

describe("ClaudeCodeSessions", () => {
  describe("take", () => {
    it("finds the session holding everything before the new user messages", () => {
      const sessions = new ClaudeCodeSessions();
      sessions.keep(first, reply, "sess-1");
      expect(sessions.take(next)).toEqual({ session_id: "sess-1", delta: [{ role: "user", content: "More" }] });
    });

    it("finds nothing for a conversation with no reply yet", () => {
      const sessions = new ClaudeCodeSessions();
      sessions.keep(first, reply, "sess-1");
      expect(sessions.take(first)).toBeUndefined();
    });

    it("finds nothing when the last message is the assistant's", () => {
      const sessions = new ClaudeCodeSessions();
      sessions.keep(first, reply, "sess-1");
      expect(sessions.take({ ...first, messages: next.messages.slice(0, 2) })).toBeUndefined();
    });

    it("finds nothing when the system prompt changed", () => {
      const sessions = new ClaudeCodeSessions();
      sessions.keep(first, reply, "sess-1");
      expect(sessions.take({ ...next, system: "other" })).toBeUndefined();
    });

    it("forgets a conversation idle past its time to live", () => {
      let now = 0;
      const sessions = new ClaudeCodeSessions({ ttl_ms: 1_000, now: () => now });
      sessions.keep(first, reply, "sess-1");
      now = 1_001;
      expect(sessions.take(next)).toBeUndefined();
    });
  });

  describe("keep", () => {
    it("forgets the oldest conversation beyond its capacity", () => {
      const sessions = new ClaudeCodeSessions({ max_entries: 1 });
      sessions.keep(first, reply, "sess-1");
      sessions.keep({ ...first, system: "other" }, reply, "sess-2");
      expect(sessions.take(next)).toBeUndefined();
      expect(sessions.take({ ...next, system: "other" })?.session_id).toBe("sess-2");
    });
  });
});
