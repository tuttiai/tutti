/**
 * Unit tests for the Claude Code session registry kept on disk: a new
 * {@link ClaudeCodeSessions} on the same file resumes what the last one kept.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatRequest, ContentBlock } from "@tuttiai/types";

import { ClaudeCodeProvider } from "../src/providers/claude-code.js";
import { ClaudeCodeSessions } from "../src/providers/claude-code-sessions.js";

const first: ChatRequest = { model: "m", system: "s", messages: [{ role: "user", content: "Hi" }] };
const reply: ContentBlock[] = [{ type: "text", text: "Hello" }];
const next: ChatRequest = {
  ...first,
  messages: [...first.messages, { role: "assistant", content: reply }, { role: "user", content: "More" }],
};

let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tutti-cc-sessions-"));
  file = join(root, "state", "claude-code-sessions.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ClaudeCodeSessions with a file", () => {
  it("resumes in a new instance what the last one kept", () => {
    new ClaudeCodeSessions({ file }).keep(first, reply, "sess-1");

    expect(new ClaudeCodeSessions({ file }).take(next)?.session_id).toBe("sess-1");
  });

  it("writes the claim, so a session is never resumed twice across a restart", () => {
    new ClaudeCodeSessions({ file }).keep(first, reply, "sess-1");
    new ClaudeCodeSessions({ file }).take(next);

    expect(new ClaudeCodeSessions({ file }).take(next)).toBeUndefined();
  });

  it("holds hashes and session ids only, never message content", () => {
    new ClaudeCodeSessions({ file }).keep(first, reply, "sess-1");

    const written = readFileSync(file, "utf8");
    expect(written).toContain("sess-1");
    expect(written).not.toContain("Hello");
    expect(readdirSync(join(root, "state"))).toEqual(["claude-code-sessions.json"]);
  });

  it("drops entries past their time to live when it loads", () => {
    let now = 0;
    new ClaudeCodeSessions({ file, now: () => now }).keep(first, reply, "sess-1");
    now = 3_600_001;

    const sessions = new ClaudeCodeSessions({ file, now: () => now });

    expect(sessions.take(next)).toBeUndefined();
  });

  it("keeps the newest entries up to the cap when it loads", () => {
    const writer = new ClaudeCodeSessions({ file });
    writer.keep(first, reply, "sess-old");
    writer.keep({ ...first, system: "other" }, reply, "sess-new");

    const sessions = new ClaudeCodeSessions({ file, max_entries: 1 });

    expect(sessions.take(next)).toBeUndefined();
    expect(sessions.take({ ...next, system: "other" })?.session_id).toBe("sess-new");
  });

  it.each([
    ["not JSON", "{ nope"],
    ["the wrong shape", JSON.stringify({ version: 2, entries: [] })],
    ["a malformed entry", JSON.stringify({ version: 1, entries: [["k", { session_id: 3 }]] })],
  ])("starts empty from a file holding %s, and recovers on the next write", (_why, content) => {
    new ClaudeCodeSessions({ file }).keep(first, reply, "sess-1");
    writeFileSync(file, content);

    const sessions = new ClaudeCodeSessions({ file });
    expect(sessions.take(next)).toBeUndefined();
    sessions.keep(first, reply, "sess-2");

    expect(new ClaudeCodeSessions({ file }).take(next)?.session_id).toBe("sess-2");
  });

  it("starts empty when the file is missing and writes nothing until something changes", () => {
    const sessions = new ClaudeCodeSessions({ file });

    expect(sessions.take(next)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it("keeps working in memory when the file cannot be written", () => {
    writeFileSync(join(root, "state"), "a file where the directory should be");
    const sessions = new ClaudeCodeSessions({ file });

    expect(() => sessions.keep(first, reply, "sess-1")).not.toThrow();
    expect(sessions.take(next)?.session_id).toBe("sess-1");
  });

  it("starts empty when the file cannot be read", () => {
    const sessions = new ClaudeCodeSessions({ file: root });

    expect(sessions.take(next)).toBeUndefined();
  });
});

describe("ClaudeCodeProvider sessions_file", () => {
  it("keeps its registry in the file it is given", async () => {
    const provider = new ClaudeCodeProvider({
      sessions_file: file,
      runner: async () => ({
        exit_code: 0,
        stdout: JSON.stringify({
          type: "result",
          is_error: false,
          session_id: "cli-1",
          structured_output: { text: "Hello", tool_calls: [] },
        }),
        stderr: "",
        timed_out: false,
      }),
    });

    await provider.chat(first);

    expect(readFileSync(file, "utf8")).toContain("cli-1");
  });
});
