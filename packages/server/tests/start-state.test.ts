import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeProvider } from "@tuttiai/core";

import { buildStartProvider, startClaudeCodeOptions } from "../src/start-provider.js";
import { buildStartRuntime } from "../src/start-runtime.js";
import { readStartState, usableStartState } from "../src/start-state.js";
import { createMockProvider, textResponse } from "./helpers.js";

function reader(vars: Record<string, string>): (key: string) => string | undefined {
  const map = new Map(Object.entries(vars));
  return (key) => map.get(key);
}

describe("readStartState", () => {
  it("reads nothing as no state directory", () => {
    expect(readStartState(reader({}))).toBeUndefined();
    expect(readStartState(reader({ TUTTI_STATE_DIR: "  " }))).toBeUndefined();
  });

  it("lays out the sessions directory and the Claude Code registry under it", () => {
    expect(readStartState(reader({ TUTTI_STATE_DIR: " /state " }))).toEqual({
      sessions: "/state/sessions",
      claude_code_sessions: "/state/claude-code-sessions.json",
      claude_config: "/state/claude",
    });
  });

  it.each(["state", "./state", "../state", "/state\0x"])("refuses %j", (value) => {
    expect(() => readStartState(reader({ TUTTI_STATE_DIR: value }))).toThrow(
      "TUTTI_STATE_DIR must be an absolute path",
    );
  });
});

describe("start with a state directory", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function state(): NonNullable<ReturnType<typeof readStartState>> {
    root = mkdtempSync(join(tmpdir(), "tutti-start-state-"));
    const paths = readStartState(reader({ TUTTI_STATE_DIR: root }));
    if (!paths) throw new Error("expected paths");
    return paths;
  }

  it("keeps sessions on disk, so a new runtime continues them", async () => {
    const paths = state();
    const score = (text: string) => ({
      provider: createMockProvider([textResponse(text)]),
      agents: { a: { name: "a", model: "m", system_prompt: "s", voices: [] } },
    });

    const first = await buildStartRuntime(score("one"), paths).run("a", "hi");
    const restarted = buildStartRuntime(score("two"), paths);
    const second = await restarted.run("a", "again", first.session_id);

    expect(second.session_id).toBe(first.session_id);
    expect((await restarted.loadSession(first.session_id))?.messages).toHaveLength(4);
  });

  it("accepts a writable directory and creates sessions under it", () => {
    const paths = state();
    const warn = vi.fn();

    expect(usableStartState(paths, warn)).toBe(paths);
    expect(warn).not.toHaveBeenCalled();
    expect(existsSync(paths.sessions)).toBe(true);
    expect(existsSync(paths.claude_config)).toBe(true);
  });

  it("passes no state through untouched", () => {
    const warn = vi.fn();
    expect(usableStartState(undefined, warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("sets aside a directory that cannot be created, with a warning", () => {
    const paths = state();
    // A file where the directory should be: refused even for root.
    rmSync(join(paths.sessions, ".."), { recursive: true, force: true });
    writeFileSync(join(paths.sessions, ".."), "not a directory");
    const warn = vi.fn();

    expect(usableStartState(paths, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) }),
      expect.stringContaining("keeping sessions in memory"),
    );
  });

  it.skipIf(process.getuid?.() === 0)("sets aside a directory it may not write, as a root-owned /state", () => {
    const paths = state();
    const dir = join(paths.sessions, "..");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    const warn = vi.fn();
    try {
      expect(usableStartState(paths, warn)).toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("starts with sessions in memory when the file store cannot open its directory", async () => {
    const paths = state();
    writeFileSync(paths.sessions, "not a directory");
    const runtime = buildStartRuntime(
      {
        provider: createMockProvider([textResponse("one"), textResponse("two")]),
        agents: { a: { name: "a", model: "m", system_prompt: "s", voices: [] } },
      },
      paths,
    );

    const first = await runtime.run("a", "hi");
    const second = await runtime.run("a", "again", first.session_id);

    expect(second.session_id).toBe(first.session_id);
  });

  it("gives the Claude Code provider its registry file", () => {
    expect(buildStartProvider("claude-code", state())).toBeInstanceOf(ClaudeCodeProvider);
  });
});

describe("startClaudeCodeOptions", () => {
  const paths = readStartState(reader({ TUTTI_STATE_DIR: "/state" }));

  it("points the CLI at <dir>/claude when CLAUDE_CONFIG_DIR is not set", () => {
    expect(startClaudeCodeOptions(paths, reader({}))).toEqual({
      sessions_file: "/state/claude-code-sessions.json",
      config_dir: "/state/claude",
    });
  });

  it("leaves a CLAUDE_CONFIG_DIR that is already set alone", () => {
    expect(startClaudeCodeOptions(paths, reader({ CLAUDE_CONFIG_DIR: "/home/me/.claude" }))).toEqual({
      sessions_file: "/state/claude-code-sessions.json",
    });
  });

  it("changes nothing without a usable state directory", () => {
    expect(startClaudeCodeOptions(undefined, reader({}))).toEqual({});
  });
});
