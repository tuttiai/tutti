/**
 * Unit tests for {@link runClaudeCode}, the default process runner.
 * `node:child_process` is mocked with an in-memory child, so no process is
 * started and nothing depends on how fast the host can spawn one.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import {
  runClaudeCode,
  type ClaudeCodeInvocation,
  type ClaudeCodeRunResult,
} from "../src/providers/claude-code-process.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

/** An in-memory child process; `kill` closes it as a SIGKILL would. */
function fakeChild(): EventEmitter & {
  stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => child.emit("close", null)),
  });
  spawn.mockReturnValueOnce(child);
  return child;
}

function start(extra: Partial<ClaudeCodeInvocation> = {}): Promise<ClaudeCodeRunResult> {
  return runClaudeCode({
    command: "claude",
    args: ["-p"],
    stdin: "",
    timeout_ms: 5_000,
    cwd: "/work",
    ...extra,
  });
}

beforeEach(() => {
  spawn.mockReset();
});

describe("runClaudeCode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("adds the invocation's variables on top of the server's environment", async () => {
    vi.stubEnv("TUTTI_TEST_INHERITED", "kept");
    const child = fakeChild();
    const pending = start({ env: { CLAUDE_CONFIG_DIR: "/state/claude" } });
    child.emit("close", 0);
    await pending;

    expect(spawn).toHaveBeenCalledWith("claude", ["-p"], expect.objectContaining({
      cwd: "/work",
      shell: false,
      env: expect.objectContaining({ CLAUDE_CONFIG_DIR: "/state/claude", TUTTI_TEST_INHERITED: "kept" }),
    }));
  });

  it("lets the CLI inherit the server's environment when none is added", async () => {
    const child = fakeChild();
    const pending = start();
    child.emit("close", 0);
    await pending;

    // Without `env`, spawn passes the whole parent environment through.
    expect(spawn.mock.calls[0]?.[2]).not.toHaveProperty("env");
  });

  it("feeds stdin and captures stdout, stderr and the exit code", async () => {
    const child = fakeChild();
    const pending = start({ stdin: "hello" });
    child.stdout.emit("data", Buffer.from("HEL"));
    child.stdout.emit("data", Buffer.from("LO"));
    child.stderr.emit("data", Buffer.from("warn"));
    child.emit("close", 3);

    expect(child.stdin.end).toHaveBeenCalledWith("hello");
    expect(await pending).toMatchObject({ exit_code: 3, stdout: "HELLO", stderr: "warn", timed_out: false });
  });

  it("kills a run that exceeds its timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const child = fakeChild();
    const pending = start({ timeout_ms: 100 });

    await vi.advanceTimersByTimeAsync(99);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(await pending).toMatchObject({ timed_out: true, exit_code: null });
  });

  it("reports a missing binary as a spawn error rather than rejecting", async () => {
    const child = fakeChild();
    const pending = start({ command: "definitely-not-a-claude-binary" });
    child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));

    expect((await pending).spawn_error?.code).toBe("ENOENT");
  });

  it("swallows an EPIPE on stdin and reports the exit through close", async () => {
    const child = fakeChild();
    const pending = start({ stdin: "too late" });
    child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    child.emit("close", 1);

    expect(await pending).toMatchObject({ exit_code: 1, timed_out: false });
  });
});

describe("runClaudeCode with a signal", () => {
  it("kills the process when the signal aborts", async () => {
    const controller = new AbortController();
    const child = fakeChild();
    const pending = start({ signal: controller.signal });
    controller.abort();

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(await pending).toMatchObject({ aborted: true, timed_out: false, exit_code: null });
  });

  it("never starts the process when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await start({ signal: controller.signal });

    expect(spawn).not.toHaveBeenCalled();
    expect(result.aborted).toBe(true);
    expect(result.spawn_error).toBeUndefined();
  });

  it("leaves aborted unset on a run that finished normally", async () => {
    const child = fakeChild();
    const pending = start({ signal: new AbortController().signal });
    child.stdout.emit("data", Buffer.from("ok"));
    child.emit("close", 0);

    const result = await pending;
    expect(result).toMatchObject({ exit_code: 0, stdout: "ok" });
    expect(result.aborted).toBeUndefined();
  });
});
